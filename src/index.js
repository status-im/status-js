const Web3 = require('web3');
const utils = require('./utils.js');
const mailservers = require('./mailservers.js');
const constants = require('./constants');

const { utils: { asciiToHex, hexToAscii  }  } = Web3;


function createStatusPayload(content, messageType, clockValue, isJson) {
  const tag = constants.messageTags.message;
  const oneMonthInMs = 60 * 60 * 24 * 31 * 1000;
  if(clockValue < (new Date().getTime())){
    clockValue = (new Date().getTime() + oneMonthInMs) * 100;
  }

  const contentType = (isJson ? 'content/json' : 'text/plain');
  const timestamp = new Date().getTime();

  return asciiToHex(
    JSON.stringify([
      tag,
      [content, contentType, messageType, clockValue, timestamp, ["^ ","~:text", content]],
    ]),
  );
}

const _sig = new WeakMap();
class StatusJS {

  constructor() {
    this.channels = {};
    this.contacts = {};
    this.userMessagesSubscription = null;
    this.mailservers = null;
    this.isHttpProvider = false;
  }

  async connect(url, privateKey) {
    let web3 = new Web3();
    if(url.startsWith("ws://")){
      web3.setProvider(new Web3.providers.WebsocketProvider(url, {headers: {Origin: "statusjs"}}));
    } else if(url.startsWith("http://") || url.startsWith("https://")) {
      // Deprecated but required for statusd
      web3.setProvider(new Web3.providers.HttpProvider(url));
      this.isHttpProvider = true;
    } else {
      const net = require('net');
      web3.setProvider(new Web3.providers.IpcProvider(url, net));
    }

    this.shh = web3.shh;
    this.mailservers = new mailservers(web3);

    await web3.shh.setMinPoW(constants.post.POW_TARGET);
    _sig.set(
      this,
      privateKey ? await this.generateWhisperKeyFromWallet(privateKey) : await web3.shh.newKeyPair()
    );
  }

  isConnected() {
    return this.shh.isListening();
  }

  async generateWhisperKeyFromWallet(key){
    await this.shh.addPrivateKey(key);
    return;
  }

  async getPublicKey(){
    const pubKey = await this.shh.getPublicKey(_sig.get(this));
    return pubKey;
  }

  async getUserName(pubKey){
    if(!pubKey) {
      pubKey = await this.getPublicKey();
    }

    return utils.generateUsernameFromSeed(pubKey);
  }

  async joinChat(channelName, cb) {
    let channelKey = await this.shh.generateSymKeyFromPassword(channelName);
    this.channels[channelName] = {
      channelName,
      channelKey,
      lastClockValue: 0,
      channelCode: Web3.utils.sha3(channelName).slice(0, 10)
    };
    if (cb) cb();
  }

  async addContact(contactCode, cb) {
    this.contacts[contactCode] = {
      username: utils.generateUsernameFromSeed(contactCode),
      lastClockValue: 0
    };
    if (cb) cb();
  }

  leaveChat(channelName) {
    if(!this.isHttpProvider) {
      this.channels[channelName].subscription.unsubscribe();
    } else {
      // TODO: fix me
      //web3.shh.deleteMessageFilter(this.channels[channelName].filterId)
      //  .then(result => {
      //    clearInterval(this.channels[channelName].interval);
      //  });
    }
    delete this.channels[channelName];
  }

  async removeContact(contactCode, _cb) {
    delete this.contacts[contactCode];
  }

  isSubscribedTo(channelName) {
    return !!this.channels[channelName];
  }

  onMessage(par1, par2) {
    if(typeof par1 === "function"){
      this.onUserMessage(par1);
    } else {
      this.onChannelMessage(par1, par2);
    }
  }

  onChatRequest(cb){
    this.chatRequestCb = cb;
  }

  onChannelMessage(channelName, cb) {
    if (!this.channels[channelName]) {
      return cb("unknown channel: " + channelName);
    }

    const filters = {
      symKeyID: this.channels[channelName].channelKey,
      topics: [this.channels[channelName].channelCode],
      allowP2P: true
    };

    const messageHandler = (data) => {
      let username = utils.generateUsernameFromSeed(data.sig);
      const payloadArray = JSON.parse(hexToAscii(data.payload));
      if(this.channels[channelName].lastClockValue < payloadArray[1][3]){
        this.channels[channelName].lastClockValue = payloadArray[1][3];
      }
      cb(null, {payload: hexToAscii(data.payload), data: data, username: username});
    };

    if(this.isHttpProvider){
      this.shh.newMessageFilter(filters)
      .then(filterId => {
        this.channels[channelName].filterId = filterId;
        this.channels[channelName].interval = setInterval(() => {
          this.shh.getFilterMessages(filterId)
          .then(data => {
            data.map(d => {
              messageHandler(d);
            });
          })
          .catch((err) => { cb(err); });
        }, 250);
      });
    } else {
      this.channels[channelName].subscription = this.shh.subscribe("messages", filters)
                                                              .on('data', messageHandler)
                                                              .on('error', (err) => { cb(err); });
    }
  }

  onUserMessage(cb) {

    const filters = {
      minPow: constants.post.POW_TARGET,
      privateKeyID: _sig.get(this),
      topics: [constants.topics.CONTACT_DISCOVERY_TOPIC],
      allowP2P: true
    };

    const messageHandler = (data) => {
      if(!this.contacts[data.sig]){
        this.addContact(data.sig);
      }

      const payloadArray = JSON.parse(hexToAscii(data.payload));
      if(this.contacts[data.sig].lastClockValue < payloadArray[1][3]){
        this.contacts[data.sig].lastClockValue = payloadArray[1][3];
      }

      if(payloadArray[0] === constants.messageTags.message){
        cb(null, {payload: hexToAscii(data.payload), data: data, username: this.contacts[data.sig].username});
      } else if(payloadArray[0] === constants.messageTags.chatRequest) {
        this.contacts[data.sig].displayName = payloadArray[1][0];
        this.contacts[data.sig].profilePic = payloadArray[1][1];

        if(this.chatRequestCb){
          this.chatRequestCb(null, {
            'username': this.contacts[data.sig].username,
            'displayName': this.contacts[data.sig].displayName,
            'profilePic': this.contacts[data.sig].profilePic,
          });
        }
      }
    };


    if(this.isHttpProvider){
      this.shh.newMessageFilter(filters)
      .then(filterId => {
        this.userMessagesSubscription = {};
        this.userMessagesSubscription.filterId = filterId;
        this.userMessagesSubscription.interval = setInterval(() => {
          this.shh.getFilterMessages(filterId)
          .then(data => {
            data.map(d => {
              messageHandler(d);
            });
          })
          .catch((err) => { cb(err); });
        }, 250);
      });
    } else {
      this.userMessagesSubscription = this.shh.subscribe("messages", filters)
                                                     .on('data', (data) => { messageHandler(data); })
                                                     .on('error', (err) => { cb(err); });
    }
  }

  sendUserMessage(contactCode, msg, cb) {
    if(!this.contacts[contactCode]){
      this.addContact(contactCode);
    }
    this.contacts[contactCode].lastClockValue++;

    this.shh.post({
      pubKey: contactCode,
      sig: _sig.get(this),
      ttl: constants.post.TTL,
      topic: constants.topics.CONTACT_DISCOVERY_TOPIC,
      payload: createStatusPayload(msg, constants.messageTypes.USER_MESSAGE, this.contacts[contactCode].lastClockValue),
      powTime: constants.post.POW_TIME,
      powTarget: constants.post.POW_TARGET
    }).then(() => {
      if (!cb) return;
      cb(null, true);
    }).catch((e) => {
      if (!cb) return;
      cb(e, false);
    });
  }

  sendGroupMessage(channelName, msg, cb) {
    if (!this.channels[channelName]) {
      if(!cb) return;
      return cb("unknown channel: " + channelName);
    }

    this.channels[channelName].lastClockValue++;

    this.shh.post({
      symKeyID: this.channels[channelName].channelKey,
      sig: _sig.get(this),
      ttl: constants.post.TTL,
      topic: this.channels[channelName].channelCode,
      payload: createStatusPayload(msg, constants.messageTypes.GROUP_MESSAGE, this.channels[channelName].lastClockValue),
      powTime: constants.post.POW_TIME,
      powTarget: constants.post.POW_TARGET
    }).then(() => {
      if (!cb) return;
      cb(null, true);
    }).catch((e) => {
      if (!cb) return;
      cb(e, false);
    });
  }

  sendJsonMessage(destination, msg, cb) {
    if (constants.regExp.CONTACT_CODE_REGEXP.test(destination)) {
      if(!this.contacts[destination]){
        this.addContact(destination);
      }
      this.contacts[destination].lastClockValue++;

      this.shh.post({
        pubKey: destination,
        sig: _sig.get(this),
        ttl: constants.post.TTL,
        topic: constants.topics.CONTACT_DISCOVERY_TOPIC,
        payload: createStatusPayload(msg, constants.messageTypes.USER_MESSAGE, this.contacts[destination].lastClockValue, true),
        powTime: constants.post.POW_TIME,
        powTarget: constants.post.POW_TARGET
      }).then(() => {
        if (!cb) return;
        cb(null, true);
      }).catch((e) => {
        if (!cb) return;
        cb(e, false);
      });
    } else {
      this.channels[destination].lastClockValue++;

      this.shh.post({
        symKeyID: this.channels[destination].channelKey,
        sig: _sig.get(this),
        ttl: constants.post.TTL,
        topic: this.channels[destination].channelCode,
        payload: createStatusPayload(JSON.stringify(msg), constants.messageTypes.GROUP_MESSAGE, this.channels[destination].lastClockValue, true),
        powTime: constants.post.POW_TIME,
        powTarget: constants.post.POW_TARGET
      }).then(() => {
        if (!cb) return;
        cb(null, true);
      }).catch((e) => {
        if (!cb) return;
        cb(e, false);
      });
    }
  }

  sendMessage(destination, msg, cb){
    if (constants.regExp.CONTACT_CODE_REGEXP.test(destination)) {
      this.sendUserMessage(destination, msg, cb);
    } else {
      this.sendGroupMessage(destination, msg, cb);
    }
  }

}

module.exports = StatusJS;
