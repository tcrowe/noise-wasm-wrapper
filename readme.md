
# noise-wasm-wrapper

Handshake, encrypt, and decrypt with noise.

It wraps [noise-c.wasm](https://github.com/nazar-pc/noise-c.wasm) into a *slightly* easier API. Being that it depends on wasm it should work in the browser and nodejs.

+ [Usage](#usage)
  * [Create key pairs](#create-key-pairs)
  * [Responder](#responder)
  * [Initiator](#initiator)
+ [API](#api)
  * [createKeyPair](#createkeypair)
  * [createNoise](#createnoise)
+ [Development](#development)
+ [To-do](#todo)


The examples use a TCP server but you could use other protocols like [UTP](https://github.com/mafintosh/utp). It just assumes the stream or socket have the `.write` function so it can handshake. After the handshake you get `encrypt` and `decrypt` methods for the rest.

The hope is that it's a useful and robust module which can be depended on as a fundamental building block for bigger things. Maybe someone who knows how can roll this into a duplex stream module to make it easier.

## Usage

### Create key pairs

Create key pairs for the local and remote nodes. [./examples/create-key-pairs.js](./examples/create-key-pairs.js)

`node ./examples/create-key-pairs.js`

```js
const fs = require("fs");
const path = require("path");
const { createKeyPair } = require("noise-wasm-wrapper");
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
```

### Responder

Create responder socket. The resonder waits until the initiator initiates the handshake. [./examples/responder.js](./examples/responder.js)

`node ./examples/responder.js`

```js
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
```

### Initiator

Create the initiator and start the handshake with the responder. [./examples/initiator.js](./examples/initiator.js)

`node ./examples/inititator.js`

```js
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
```

## API

### createKeyPair

The default curve id is `NOISE_DH_CURVE25519`.

Create the public and private key pair
@method createKeyPair
@param {string} [curveId]
@param {function} done

You can review he [key pair curve id list](https://github.com/nazar-pc/noise-c.wasm/blob/master/src/constants.ls#L27). At the time of writing this only two work, `NOISE_DH_CURVE25519` and `NOISE_DH_CURVE448`.

```js
const { createKeyPair }  = require("noise-wasm-wrapper");

createKeyPair(function(err, keyPair) {
  console.log("err", err);
  console.log("keyPair", keyPair);
});
```

### createNoise

Create the noise object with the configurations for your network.

The callback provides (err, { noise, handshakeState, handshake })
+ {object} error
+ {object} response
+ {object} response.noise
+ {object} response.handshakeState noise wasm handshake object
+ {function} response.handshake

@method createNoise
+ @param {object} opts
+ @param {string} [opts.pattern="XK"]
+ @param {string} [opts.curve="25519"]
+ @param {string} [opts.cipher="ChaChaPoly"]
+ @param {string} [opts.hash="BLAKE2b"]
+ @param {string|buffer} [opts.prologue] shared secret message
+ @param {string|buffer} [opts.psk] pre-shared symmetric key
+ @param {string} [opts.mode="responder"] "initiator" or "responder"
+ @param {object} opts.keyPair
+ @param {array|buffer} opts.keyPair.publicKey
+ @param {array|buffer} opts.keyPair.privateKey
+ @param {array|buffer} [opts.remotePublicKey] required if initiator
+ @param {function} done

```js
const { createNoise } = require("noise-wasm-wrapper");

// get the key pairs
// const responderKeyPair = { publicKey: [...], privateKey: [...]}
// const initiatorKeyPair = { publicKey: [...], privateKey: [...]}

// create responder noise instance
createNoise({ keyPair: responderKeyPair }, function({ handshake }) {
  // go handshake the stream
});

// create initiator noise instance
createNoise({ keyPair: initiatorKeyPair, remotePublicKey: responderKeyPair.publicKey }, function({ handshake }) {
  // go handshake the stream
});
```

#### handshake

Once you `createNoise` you'll get a handshake function. It will listen for or initiate the handshake with the peer.

The callback provides:
+ {object} error
+ {object} response.handshakeState
+ {function} response.encrypt
+ {function} response.decrypt
+ {function} response.getRemotePublicKey
+ {function} response.getHandshakeHash

@method handshake
+ @param {object} options.socket
+ @param {number} [options.maxHandshakeOperations=12]
+ @param {function} done

[HandshakeState](https://github.com/nazar-pc/noise-c.wasm#noisehandshakestateprotocol_name-role)

`cipherStateSend` and `cipherStateReceive` are from a [CipherState](https://github.com/nazar-pc/noise-c.wasm#noisecipherstatecipher) created by calling `HandshakeState.Split()`.

## Development

```sh
# clean up coverage files and eslint cache
npm run clean

# run for continuous development tasks
npm run dev

# run before publishing to ensure tests run
npm run prd

# other tasks which can be run individually
npm run dev-eslint
npm run dev-test
npm run test
npm run coverage
npm run prd-eslint
```

## Todo

+ Possibly bugs out if trying to send data too quickly after the handshake
+ PSK(pre-shared symmetric key) feature with [SymmetricState](https://github.com/nazar-pc/noise-c.wasm#noisesymmetricstateprotocol_name)
+ It should be determined when we should call `free()` if needed as well.
+ `getRemotePublicKey` implemented, not tested
+ `getHandshakeHash` implemented, not tested

## Copying, license, and contributing

Copyright (C) Tony Crowe <github@tonycrowe.com> (https://tcrowe.github.io) 2018

Thank you for using and contributing to make noise-wasm-wrapper better.

⚠️ Please run `npm run prd` before submitting a patch.

⚖️ noise-wasm-wrapper is Free Software protected by the GPL 3.0 license. See [./COPYING](./COPYING) for more information. (free as in freedom)
