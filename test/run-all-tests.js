const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('==========================================');
  console.log('   Running Hello CSV Test Suite           ');
  console.log('==========================================\n');

  // 1. Run parser tests
  console.log('-> 1. Parser Unit Tests:');
  execSync('node test/test-parser.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });

  // 2. Bundle and run streamer tests
  console.log('\n-> 2. Streamer & Virtual Pagination Tests:');
  const tempTestBundle = path.join(__dirname, 'dist-test.js');
  try {
    execSync(`npx esbuild test/test-streamer.ts --bundle --platform=node --outfile="${tempTestBundle}"`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    });
    execSync(`node "${tempTestBundle}"`, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  } finally {
    if (fs.existsSync(tempTestBundle)) {
      fs.unlinkSync(tempTestBundle);
    }
  }

  console.log('\n==========================================');
  console.log('   All Hello CSV tests passed cleanly!    ');
  console.log('==========================================\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

