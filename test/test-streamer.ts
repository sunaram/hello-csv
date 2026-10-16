import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CsvStreamIndexer, sniffFile } from '../src/csvStreamer';

async function runTests() {
  console.log('--- Running CsvStreamIndexer TypeScript Tests ---');

  const testFile = path.join(__dirname, 'test_unit_data.csv');
  const content = [
    'id,name,role,salary',
    '1,"Alice, Team Lead",Engineering,120000',
    '2,"Bob",Design,95000',
    '3,"Charlie\nMultiline",Engineering,110000',
    '4,"David",Marketing,80000',
    '5,"Emma",Engineering,130000',
    '6,"Frank",Finance,105000',
    '7,"Grace",Engineering,125000',
  ].join('\n') + '\n';

  fs.writeFileSync(testFile, content, 'utf-8');

  try {
    // 1. Test sniffFile
    const sniff = await sniffFile(testFile);
    assert.strictEqual(sniff.delimiter, ',');
    assert.strictEqual(sniff.headers.length, 4);
    assert.strictEqual(sniff.headers[0], 'id');
    assert.strictEqual(sniff.headers[1], 'name');
    assert.strictEqual(sniff.initialRows.length, 7);
    console.log('✓ Test 1: sniffFile detected headers & initial rows correctly');

    // 2. Test CsvStreamIndexer buildIndex & totalDataRows
    const indexer = new CsvStreamIndexer(testFile, sniff.fileSize, {
      hasHeader: true,
      delimiter: sniff.delimiter,
      totalColumns: sniff.totalColumns,
    });

    const totalRows = await indexer.startIndexing();
    assert.strictEqual(totalRows, 7, 'Should have exactly 7 data rows');
    assert.strictEqual(indexer.totalDataRows, 7);
    console.log('✓ Test 2: startIndexing computed 7 data rows correctly');

    // 3. Test getPage random seek
    const page1 = await indexer.getPage(1, 3);
    assert.strictEqual(page1.rows.length, 3);
    assert.strictEqual(page1.rows[0][0], '1');
    assert.strictEqual(page1.rows[0][1], 'Alice, Team Lead');
    assert.strictEqual(page1.rows[2][0], '3');
    assert.strictEqual(page1.rows[2][1], 'Charlie\nMultiline');
    console.log('✓ Test 3: getPage retrieved exact page rows with multiline quotes');

    const page2 = await indexer.getPage(2, 3);
    assert.strictEqual(page2.rows.length, 3);
    assert.strictEqual(page2.rows[0][0], '4');
    assert.strictEqual(page2.rows[0][1], 'David');
    assert.strictEqual(page2.rows[2][0], '6');
    assert.strictEqual(page2.rows[2][1], 'Frank');
    console.log('✓ Test 4: getPage 2 retrieved next slice correctly');

    // 4. Test streaming search for "Engineering"
    const searchMatches: any[] = [];
    await indexer.streamingSearch('Engineering', (batch, ratio, done) => {
      searchMatches.push(...batch);
    });

    assert.strictEqual(searchMatches.length, 4, 'Should find 4 Engineering rows');
    assert.strictEqual(searchMatches[0].row[1], 'Alice, Team Lead');
    assert.strictEqual(searchMatches[1].row[1], 'Charlie\nMultiline');
    assert.strictEqual(searchMatches[2].row[1], 'Emma');
    assert.strictEqual(searchMatches[3].row[1], 'Grace');
    console.log('✓ Test 5: streamingSearch found all 4 matching rows');

    // 5. Test saveDeltaEdits
    const modified: Record<number, string[]> = {
      1: ['2', 'Robert (Updated)', 'Design', '99000'],
      4: ['5', 'Emma Watson', 'Engineering', '150000'],
    };

    await indexer.saveDeltaEdits(modified, sniff.headers);

    // Re-read file to verify atomic update
    const updatedContent = fs.readFileSync(testFile, 'utf-8');
    assert.ok(updatedContent.includes('Robert (Updated)'), 'Updated row 1 saved');
    assert.ok(updatedContent.includes('Emma Watson'), 'Updated row 4 saved');
    assert.ok(updatedContent.includes('Charlie\nMultiline'), 'Untouched multiline row preserved');
    console.log('✓ Test 6: saveDeltaEdits atomic streaming update verified');

    console.log('\nAll CsvStreamIndexer TypeScript tests passed successfully!');
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});

