const { createServer } = require("net");
const isNil = require("lodash/isNil");
const noise = require("../src");
const keyPair = require("./responder-keypair.json");
const noiseOpts = { keyPair };
const port = 14912;
const host = "127.0.0.1";
let responder;
let intervals = [];
const intervalDelay = 500; // time between messages

/**
 * Try to gracefully shutdown so the port doesn't stay active
 * @method shutdown
 * @param {number} code
 */
function shutdown(code = 0) {
  // stop the server
  if (isNil(responder) === false) {
    try {
      responder.close();
    } catch (err) {
      console.error("error closing responder", err);
    }
  }

  // stop timers
  intervals.forEach(interval => clearInterval(interval));

  process.exit(code);
}

//
// 1. Wait for a connection
//
responder = createServer(function(socket) {
  console.log("responder connection");

  //
  // 2. Make some Noise!
  //
  noise.createNoise(noiseOpts, function(err, { handshake }) {
    if (isNil(err) === false) {
      console.error("error creating noise objec", err);
      return shutdown(1);
    }

    socket.on("error", function(err) {
      console.error("responder socket error", err);
    });

    socket.on("close", function() {
      console.log("responder socket close");
    });

    //
    // 3. Wait for handshake
    //
    handshake({ socket }, function(err, res) {
      if (isNil(err) === false) {
        console.error("error handshaking socket", err);
        return shutdown(1);
      }

      //
      // 4. Send and receive encrypted data
      //
      const { encrypt, decrypt } = res;

      console.log("responder handshake success");

      socket.on("data", function(chunk) {
        //
        // decrypt incoming data
        //
        let op = decrypt(chunk);
        op = Buffer.from(op);
        op = op.toString();
        console.log("responder decrypted:", op);
      });

      //
      // Encrypt outgoing data
      //
      let counter = 0;
      const interval = setInterval(function() {
        let op = `responder message ${counter}`;
        op = Buffer.from(op);
        op = encrypt(op);
        socket.write(op);
        counter += 1;
      }, intervalDelay);

      intervals.push(interval);

      socket.on("close", function() {
        intervals = intervals.filter(function(item) {
          if (item === interval) {
            clearInterval(interval);
            return false;
          }

          return true;
        });
      });
    });
  });
});

responder.on("error", function(err) {
  console.error("responder error", err);
  shutdown(1);
});

responder.listen(port, host, function(err) {
  if (isNil(err) === false) {
    console.error("error listening", err);
    return shutdown(1);
  }

  console.log(`responder listening tcp://${host}:${port}`);
});
