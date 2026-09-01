const ISAPI_XMLNS = "http://www.isapi.org/ver20/XMLSchema";

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlDoc(rootTag, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag} version="2.0" xmlns="${ISAPI_XMLNS}">\n${inner}\n</${rootTag}>`;
}

module.exports = {
  ISAPI_XMLNS,
  escapeXml,
  xmlDoc,
};
