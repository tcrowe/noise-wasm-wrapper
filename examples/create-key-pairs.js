const fs = require("fs");
const path = require("path");
const { createKeyPair } = require("../src/index");
const initiatorKeyPairPath = path.join(__dirname, "initiator-keypair.json");
const responderKeyPairPath = path.join(__dirname, "responder-keypair.json");

/**
 * Create a callback that saves the key pair
 * @method saveKeyPair
 * @param {string} absolutePath
 * @returns {function}
 */
function saveKeyPair(absolutePath) {
  /**
   * Write file
   * @method saveKeyPairInner
   * @param {object} [err]
   * @param {object} [keyPair]
   */
  return function saveKeyPairCallback(err, keyPair) {
    if (err !== null && err !== undefined) {
      console.error("error creating key pair", err);
      return;
    }

    let op = JSON.stringify(keyPair);
    fs.writeFile(absolutePath, op, function(err) {
      if (err !== null && err !== undefined) {
        return console.error("error saving key pair", absolutePath, err);
      }
      console.log("saved", absolutePath);
    });
  };
}

createKeyPair(saveKeyPair(initiatorKeyPairPath));
createKeyPair(saveKeyPair(responderKeyPairPath));
