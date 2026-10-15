const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Dynamically load the bundled extension or parser
async function runTests() {
  console.log('--- Running CSV Viewer Unit Tests ---');

  const customersCsv = fs.readFileSync(path.join(__dirname, '../samples/customers.csv'), 'utf-8');
  const complexCsv = fs.readFileSync(path.join(__dirname, '../samples/complex_quotes.csv'), 'utf-8');

  // Load papaparse
  const Papa = require('papaparse');

  // Test 1: Simple CSV parsing
  const parsed1 = Papa.parse(customersCsv, { skipEmptyLines: 'greedy' });
  assert.strictEqual(parsed1.data.length, 16, 'Should have 1 header row + 15 data rows');
  assert.strictEqual(parsed1.data[0][0], 'ID');
  assert.strictEqual(parsed1.data[0][1], 'First Name');
  assert.strictEqual(parsed1.data[1][0], '1001');
  assert.strictEqual(parsed1.data[1][1], 'Alice');
  console.log('✓ Test 1: Customers CSV parsing verified');

  // Test 2: Complex CSV with quotes and commas
  const parsed2 = Papa.parse(complexCsv, { skipEmptyLines: 'greedy' });
  assert.strictEqual(parsed2.data.length, 5, 'Should have 1 header row + 4 data rows');
  assert.strictEqual(parsed2.data[1][1], 'Super "Turbo" Blender', 'Escaped quotes handled correctly');
  assert.strictEqual(parsed2.data[3][1], 'Coffee Maker, Deluxe Edition', 'Commas inside quotes handled correctly');
  console.log('✓ Test 2: Quotes and internal commas verified');

  // Test 3: Delimiter detection
  const tsvData = 'col1\tcol2\tcol3\nval1\tval2\tval3';
  const parsedTsv = Papa.parse(tsvData, { skipEmptyLines: 'greedy' });
  assert.strictEqual(parsedTsv.meta.delimiter, '\t', 'Should detect tab delimiter');
  console.log('✓ Test 3: Tab delimiter detection verified');

  const semiData = 'col1;col2;col3\nval1;val2;val3';
  const parsedSemi = Papa.parse(semiData, { skipEmptyLines: 'greedy' });
  assert.strictEqual(parsedSemi.meta.delimiter, ';', 'Should detect semicolon delimiter');
  console.log('✓ Test 4: Semicolon delimiter detection verified');

  // Test 5: Unparse serialization roundtrip
  const testHeaders = ['Name', 'Role', 'Notes'];
  const testRows = [['Alice', 'Engineer', 'Works on "AI", frontend, and backend']];
  const unparsed = Papa.unparse({ fields: testHeaders, data: testRows }, { delimiter: ',' });
  const reParsed = Papa.parse(unparsed);
  assert.strictEqual(reParsed.data[0][0], 'Name');
  assert.strictEqual(reParsed.data[1][2], 'Works on "AI", frontend, and backend');
  console.log('✓ Test 5: Unparse and quote-escape roundtrip verified');

  console.log('\nAll parser test assertions passed successfully!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

