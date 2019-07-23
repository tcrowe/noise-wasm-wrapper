const noiseWasm = require("noise-c.wasm");
const constants = require("noise-c.wasm/src/constants");
const isNil = require("lodash/isNil");
const isFunction = require("lodash/isFunction");
const modeInitiator = "initiator";
const modeResponder = "responder";
const fallbackSupported = false;

const initializeNoiseWasm = new Promise(function(resolve, reject) {
  try {
    noiseWasm(resolve);
  } catch (err) {
    reject(err);
  }
});

/**
 * If the user doesn't pass them these network configs are used.
 * @type {Object}
 */
const networkDefaults = {
  pattern: "XK",
  curve: "25519",
  cipher: "ChaChaPoly",
  hash: "BLAKE2b"
};

/**
 * Create the public and private key pair
 * @method createKeyPair
 * @param {string} [curveId]
 * @param {function} done
 */
function createKeyPair(curveId, done) {
  initializeNoiseWasm
    .then(function noiseWasmInitialized(noise) {
      if (isFunction(curveId) === true) {
        done = curveId;
        curveId = constants.NOISE_DH_CURVE25519;
      }
      try {
        let [privateKey, publicKey] = noise.CreateKeyPair(curveId);
        privateKey = Array.from(privateKey);
        publicKey = Array.from(publicKey);
        done(null, { privateKey, publicKey });
      } catch (err) {
        // console.log("curveId", curveId);
        // console.log("err", err);
        done(err);
      }
    })
    .catch(done);
}

/**
 * Create the noise object with the configurations for your network.
 *
 * The callback provides (err, { noise, handshakeState, handshake })
 * + {object} error
 * + {object} response
 * + {object} response.noise
 * + {object} response.handshakeState noise wasm handshake object
 * + {function} response.handshake
 *
 * @method createNoise
 * @param {object} opts
 * @param {string} [opts.pattern="XK"]
 * @param {string} [opts.curve="25519"]
 * @param {string} [opts.cipher="ChaChaPoly"]
 * @param {string} [opts.hash="BLAKE2b"]
 * @param {string|buffer} [opts.prologue] shared secret message
 * @param {string|buffer} [opts.psk] pre-shared symmetric key
 * @param {string} [opts.mode="responder"] "initiator" or "responder"
 * @param {object} opts.keyPair
 * @param {array|buffer} opts.keyPair.publicKey
 * @param {array|buffer} opts.keyPair.privateKey
 * @param {array|buffer} [opts.remotePublicKey] required if initiator
 * @param {function} done
 */
function createNoise(opts, done) {
  const {
    pattern = networkDefaults.pattern,
    curve = networkDefaults.curve,
    cipher = networkDefaults.cipher,
    hash = networkDefaults.hash,
    prologue,
    psk,
    mode = modeResponder,
    keyPair,
    remotePublicKey
  } = opts;

  const protocolName = `Noise_${pattern}_${curve}_${cipher}_${hash}`;

  /**
   * I'm not sure what the "ad" buffer/array is for but it is passed to
   * the encrypt and decrypt methods for noise wasm.
   * @type {array}
   */
  let ad = [];

  // finished handshaking or not?
  let ready = false;

  let handshakeState;
  let noise;
  let cipherStateSend;
  let cipherStateReceive;

  /**
   * Encrypt the data to send out to the peer
   * @method encrypt
   * @param {array|buffer} chunk
   */
  const encrypt = chunk => cipherStateSend.EncryptWithAd(ad, chunk);

  /**
   * Decrypt the data coming back from the peer
   * @method decrypt
   * @param {array|buffer} chunk
   */
  const decrypt = chunk => cipherStateReceive.DecryptWithAd(ad, chunk);

  /**
   * Useful to make sure you got the right peer
   * @method getRemotePublicKey
   * @returns {array|buffer}
   */
  const getRemotePublicKey = () => handshakeState.GetRemotePublicKey();

  /**
   * The peers can compare if they got the right handshake
   * @method getHandshakeHash
   * @returns {array|buffer}
   */
  const getHandshakeHash = () => handshakeState.GetHandshakeHash();

  /**
   * Listen for or initiate the handshake with the peer
   *
   * The callback provides:
   * + {object} error
   * + {object} response.handshakeState
   * + {function} response.encrypt
   * + {function} response.decrypt
   * + {object} response.cipherStateSend
   * + {object} response.cipherStateReceive
   *
   * @method handshake
   * @param {object} options.socket
   * @param {number} [options.maxHandshakeOperations=12]
   * @param {function} done
   */
  function handshake({ socket, maxHandshakeOperations = 12 }, handshakeFinal) {
    let finished = false;
    let handshakeOperations = 0;

    const handshakesExceededError = new Error(
      `handshake operations exceeded the limit of ${maxHandshakeOperations}`
    );

    function handshakeFinish(err, res) {
      // console.log("handshakeFinish");
      if (finished === true) {
        // prevent double callback
        return;
      }

      finished = true;

      if (isNil(err) === false) {
        return handshakeFinal(err);
      }

      handshakeFinal(null, res);
    }

    function prepare(chunk) {
      if (handshakeOperations >= maxHandshakeOperations) {
        handshakeFinish(handshakesExceededError);
        return;
      }

      const action = handshakeState.GetAction();

      if (action === constants.NOISE_ACTION_FAILED) {
        handshakeFinish("error", new Error("noise action failed"));
      } else if (action === constants.NOISE_ACTION_WRITE_MESSAGE) {
        //
        // send handshake packet
        //
        const writeResponse = handshakeState.WriteMessage();
        socket.write(writeResponse);
        handshakeOperations += 1;
      } else if (action === constants.NOISE_ACTION_READ_MESSAGE) {
        handshakeState.ReadMessage(chunk, fallbackSupported);
        handshakeOperations += 1;
        prepare();
      }

      if (
        ready === false &&
        handshakeState.GetAction() === constants.NOISE_ACTION_SPLIT
      ) {
        // console.log(mode, "split action");
        const split = handshakeState.Split();
        cipherStateSend = split[0];
        cipherStateReceive = split[1];

        // don't keep repeating split function
        ready = true;

        // stop listening to this event
        socket.removeListener("data", prepare);

        handshakeFinish(null, {
          handshakeState,
          encrypt,
          decrypt,
          getRemotePublicKey,
          getHandshakeHash,
          cipherStateSend,
          cipherStateReceive
        });
      }
    }

    socket.on("data", prepare);

    if (
      mode === modeInitiator &&
      ready === false &&
      handshakeState.GetAction() === constants.NOISE_ACTION_WRITE_MESSAGE
    ) {
      // console.log("initiating handshake");
      socket.write(handshakeState.WriteMessage());
    }
  }

  initializeNoiseWasm
    .then(function noiseWasmInitialized(n) {
      noise = n;

      if (mode === modeInitiator) {
        handshakeState = noise.HandshakeState(
          protocolName,
          constants.NOISE_ROLE_INITIATOR
        );
        handshakeState.Initialize(
          prologue,
          keyPair.privateKey,
          remotePublicKey,
          psk
        );
      } else {
        handshakeState = noise.HandshakeState(
          protocolName,
          constants.NOISE_ROLE_RESPONDER
        );
        handshakeState.Initialize(
          prologue,
          keyPair.privateKey,
          remotePublicKey,
          psk
        );
      }

      done(null, { noise, handshakeState, handshake });
    })
    .catch(done);
}

module.exports = { createKeyPair, createNoise, constants };
