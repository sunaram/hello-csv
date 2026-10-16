const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const testFile = path.join(__dirname, 'large_test.csv');
const ROW_COUNT = 100000;

console.log(`Generating ${ROW_COUNT} rows CSV...`);
const startGen = Date.now();
const writeStream = fs.createWriteStream(testFile);
writeStream.write('id,first_name,last_name,email,company,city,amount,status\n');

for (let i = 1; i <= ROW_COUNT; i++) {
  const company = i % 500 === 0 ? 'Acme Corporation' : `Company_${i % 73}`;
  const status = i % 2 === 0 ? 'Active' : 'Pending';
  writeStream.write(`${i},User${i},Smith,user${i}@example.com,"${company}",New York,${(i * 1.5).toFixed(2)},${status}\n`);
}

writeStream.end(async () => {
  console.log(`Generated in ${Date.now() - startGen}ms`);
  const stats = fs.statSync(testFile);
  console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  // Benchmark Byte Offset Scanning
  console.log('\n--- Benchmarking Byte Offset Indexing ---');
  const startIndex = Date.now();
  const rowOffsets = [];
  let inQuotes = false;
  let globalOffset = 0;

  const readStream = fs.createReadStream(testFile, { highWaterMark: 64 * 1024 });
  rowOffsets.push(0);

  for await (const chunk of readStream) {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 34) {
        inQuotes = !inQuotes;
      } else if (!inQuotes && chunk[i] === 10) {
        rowOffsets.push(globalOffset + i + 1);
      }
    }
    globalOffset += chunk.length;
  }

  const indexTime = Date.now() - startIndex;
  console.log(`Indexed ${rowOffsets.length} rows in ${indexTime}ms! (~${Math.round(stats.size / 1024 / 1024 / (indexTime / 1000))} MB/s)`);

  // Benchmark Instant Page Seek (e.g. Page 1,000 - rows 50,000 to 50,050)
  console.log('\n--- Benchmarking Random Page Seek (Rows 50,000 to 50,050) ---');
  const startSeek = Date.now();
  const startByte = rowOffsets[50000];
  const endByte = rowOffsets[50050];
  
  const fd = fs.openSync(testFile, 'r');
  const buffer = Buffer.alloc(endByte - startByte);
  fs.readSync(fd, buffer, 0, buffer.length, startByte);
  fs.closeSync(fd);

  const parsedSlice = Papa.parse(buffer.toString('utf-8'), { skipEmptyLines: 'greedy' });
  const seekTime = Date.now() - startSeek;
  console.log(`Seeked & parsed 50 rows in ${seekTime}ms! First row:`, parsedSlice.data[0]);

  // Benchmark Streaming Search for "Acme Corporation"
  console.log('\n--- Benchmarking Streaming Search for "Acme Corporation" ---');
  const startSearch = Date.now();
  const searchPattern = Buffer.from('Acme Corporation');
  const matches = [];
  let searchInQuotes = false;
  let lineStart = 0;
  let rowIdx = 0;

  // Let's test chunk-by-chunk search
  const searchStream = fs.createReadStream(testFile, { highWaterMark: 64 * 1024 });
  let remainder = Buffer.alloc(0);

  for await (const chunk of searchStream) {
    const combined = Buffer.concat([remainder, chunk]);
    let lastNewline = 0;
    let localInQuotes = false;

    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === 34) {
        localInQuotes = !localInQuotes;
      } else if (!localInQuotes && combined[i] === 10) {
        const lineBuf = combined.subarray(lastNewline, i);
        // Fast buffer includes check
        if (lineBuf.includes(searchPattern)) {
          matches.push({ rowIdx, text: lineBuf.toString('utf-8').replace(/\r$/, '') });
        }
        rowIdx++;
        lastNewline = i + 1;
      }
    }
    remainder = combined.subarray(lastNewline);
  }

  const searchTime = Date.now() - startSearch;
  console.log(`Found ${matches.length} matches in ${searchTime}ms! First match:`, matches[0]);

  // Clean up test file
  fs.unlinkSync(testFile);
  console.log('\nBenchmark completed successfully!');
});

