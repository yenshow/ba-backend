const { buildParametersApiPayload } = require("../../constants/environmentParameterCatalog");

function getParameters() {
  return buildParametersApiPayload();
}

module.exports = {
  getParameters,
};
