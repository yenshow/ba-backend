/**
 * personnelFileHelpers 檔名規則
 *
 *   npm run test:personnel-file-helpers
 */
const assert = require("node:assert/strict");
const {
  buildPersonnelFilename,
  listPersonnelImportZipCandidateNames,
} = require("../../src/services/personnel/personnelFileHelpers");

function run() {
  const filename = buildPersonnelFilename("張格維", "A0105", ".jpg");
  assert.equal(filename, "張格維_A0105.jpg");
  assert.ok(!filename.includes("+"), "檔名不可含 + 號");

  const withSpaces = buildPersonnelFilename("張 格 維", "A0105", ".jpg");
  assert.equal(withSpaces, "張格維_A0105.jpg");

  const zipNames = listPersonnelImportZipCandidateNames("張格維", "A0105");
  assert.deepEqual(zipNames, [
    "張格維_A0105.jpeg",
    "張格維_A0105.jpg",
    "A0105.jpeg",
    "A0105.jpg",
  ]);
  for (const name of zipNames) {
    assert.ok(!name.includes("+"), `zip 候選檔名不可含 + 號: ${name}`);
  }

  console.log("personnelFileHelpers tests passed");
}

run();
