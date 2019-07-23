const net = require("net");
const isNil = require("lodash/isNil");
const noise = require("../src/index");
const { constants } = noise;
const port = 9114;
const host = "127.0.0.1";

describe("noise-wasm-wrapper", function() {
  let intervals = [];
  let responder;
  let responderKeyPair;
  let initiatorKeyPair;
  let responderNoise;
  let initiatorNoise;
  let prologue = Buffer.from("secret shared message");

  function shutdown(code = 0) {
    intervals.forEach(interval => clearInterval(interval));

    if (isNil(responder) === false) {
      try {
        responder.close();
      } catch (err) {
        console.error("error closing responder", err);
      }
    }

    process.exit(code);
  }

  before(function() {
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("SIGHUP", shutdown);
    process.once("unhandledException", function(err) {
      console.error("unhandledException", err);
      shutdown(1);
    });
  });

  after(shutdown);

  it("key pair fail", function(done) {
    noise.createKeyPair("Eddy Two Five Five One Niner", function(err) {
      err.should.be.an.Error;
      err.message.should.eql("Invalid keypair type");
      done();
    });
  });

  // describe("key pair curve ids", function() {
  const curveIdKeys = [
    // "NOISE_DH_CATEGORY",
    "NOISE_DH_CURVE25519",
    "NOISE_DH_CURVE448"
    // "NOISE_DH_NEWHOPE"
  ];

  curveIdKeys.forEach(function(key) {
    it(`curve id ${key}`, function(done) {
      const curveId = constants[key];
      noise.createKeyPair(curveId, function(err, kp) {
        if (isNil(err) === false) {
          console.error("error creating key from curve id", key, err);
          return done(err);
        }
        kp.publicKey.should.be.an.Array;
        kp.privateKey.should.be.an.Array;
        done();
      });
    });
  });

  it("responder key pair", function(done) {
    noise.createKeyPair(function(_, kp) {
      responderKeyPair = kp;
      done();
    });
  });

  it("initiator key pair", function(done) {
    noise.createKeyPair(function(_, kp) {
      initiatorKeyPair = kp;
      done();
    });
  });

  it("create responder noise", function(done) {
    const noiseOpts = {
      // mode: "responder",
      keyPair: responderKeyPair,
      prologue
    };
    noise.createNoise(noiseOpts, function(_, ns) {
      responderNoise = ns;
      done();
    });
  });

  it("create initiator noise", function(done) {
    const noiseOpts = {
      mode: "initiator",
      keyPair: initiatorKeyPair,
      remotePublicKey: responderKeyPair.publicKey,
      prologue
    };
    noise.createNoise(noiseOpts, function(_, ns) {
      initiatorNoise = ns;
      done();
    });
  });

  it("encrypt/decrypt", function(done) {
    let responderDecrypted = false;
    let initiatorDecrypted = false;
    let finished = false;

    function tryEncryptDecryptFinish(err) {
      if (finished === true) {
        // prevent double callback
        return;
      }

      if (isNil(err) === false) {
        return done(err);
      }

      if (responderDecrypted === true && initiatorDecrypted === true) {
        finished = true;
        return done();
      }
    }

    responder = net.createServer(function(socket) {
      socket.on("error", done);

      responderNoise.handshake({ socket }, function(err, res) {
        if (isNil(err) === false) {
          return done(err);
        }

        const { encrypt, decrypt } = res;

        socket.on("data", function(chunk) {
          const op = Buffer.from(decrypt(chunk)).toString();
          op.should.be.a.String;
          op.should.startWith("initiator message");
          responderDecrypted = true;
          tryEncryptDecryptFinish();
        });

        setTimeout(function() {
          let op = Buffer.from(`responder message\n`);
          op = encrypt(op);
          socket.write(op);
        }, 100);
      });
    });

    responder.on("error", done);

    responder.listen(port, host, function(err) {
      if (isNil(err) === false) {
        console.error("responder error listening");
        return done(err);
      }
    });

    const initiator = net.connect({ port, host }, function() {
      initiatorNoise.handshake({ socket: initiator }, function(err, res) {
        if (isNil(err) === false) {
          return done(err);
        }

        const { encrypt, decrypt } = res;

        initiator.on("data", function(chunk) {
          const op = Buffer.from(decrypt(chunk)).toString();
          op.should.be.a.String;
          op.should.startWith("responder message");
          initiatorDecrypted = true;
          tryEncryptDecryptFinish();
        });

        setTimeout(function() {
          let op = Buffer.from(`initiator message\n`);
          op = encrypt(op);
          initiator.write(op);
        }, 100);
      });
    });

    initiator.on("error", done);
  });
});
