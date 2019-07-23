const { connect } = require("net");
const isNil = require("lodash/isNil");
const noise = require("../src");
const keyPair = require("./initiator-keypair.json");
const remotePublicKey = require("./responder-keypair.json").publicKey;
const noiseOpts = { mode: "initiator", keyPair, remotePublicKey };
const port = 14912;
const host = "127.0.0.1";
let interval;
const intervalDelay = 500; // time between messages
let initiator;

/**
 * Try to gracefully shutdown
 * @method shutdown
 * @param {number} code
 */
function shutdown(code = 0) {
  // stop the server
  if (isNil(initiator) === false) {
    try {
      initiator.end();
    } catch (err) {
      console.error("error closing initiator", err);
    }
  }

  // stop timers
  if (isNil(interval) === false) {
    clearInterval(interval);
  }

  process.exit(code);
}

//
// 1. Make some Noise!
//
noise.createNoise(noiseOpts, function(err, { handshake }) {
  if (isNil(err) === false) {
    console.error("error creating noise objec", err);
    return shutdown(1);
  }

  //
  // 2. Connect to the responder
  //
  initiator = connect(
    { port, host },
    function() {
      console.log("initiator connected");

      //
      // 3. Initiate the handshake
      //
      handshake({ socket: initiator }, function(err, res) {
        if (isNil(err) === false) {
          console.error("error handshaking socket", err);
          return shutdown(1);
        }

        //
        // 4. Send and receive encrypted data
        //
        const { encrypt, decrypt } = res;

        console.log("initiator handshake success");

        initiator.on("data", function(chunk) {
          //
          // decrypt incoming data
          //
          let op = decrypt(chunk);
          op = Buffer.from(op);
          op = op.toString();
          console.log("initiator decrypted:", op);
        });

        //
        // Encrypt outgoing data
        //
        let counter = 0;

        interval = setInterval(function() {
          let op = `initiator message ${counter}`;
          op = Buffer.from(op);
          op = encrypt(op);
          initiator.write(op);
          counter += 1;
        }, intervalDelay);
      });
    }
  );

  initiator.on("error", function(err) {
    console.error("initiator error", err);
    shutdown(1);
  });

  initiator.on("close", function() {
    console.log("initiator close");
    shutdown();
  });
});
