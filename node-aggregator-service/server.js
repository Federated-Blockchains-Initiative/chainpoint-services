/* Copyright (C) 2017 Tierion
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// load all environment variables into env object
const env = require('./lib/parse-env.js')('agg')

const _ = require('lodash')
const utils = require('./lib/utils')
const amqp = require('amqplib')
const MerkleTools = require('merkle-tools')
const crypto = require('crypto')
const uuidv1 = require('uuid/v1')

// An array of all hashes needing to be processed.
// Will be filled as new hashes arrive on the queue.
let HASHES = []

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// The channel used for all amqp communication
// This value is set once the connection has been established
var amqpChannel = null

function consumeHashMessage (msg) {
  if (msg !== null) {
    let hashObj = JSON.parse(msg.content.toString())

    // add msg to the hash object so that we can ack it during the aggregateAsync process
    hashObj.msg = msg
    HASHES.push(hashObj)
  }
}

/**
 * Converts proof path array output from the merkle-tools package
 * to a Chainpoint v3 ops array
 *
 * @param {proof object array} proof - The proof array generated by merkle-tools
 * @param {string} op - The hash type performed throughout merkle tree construction (sha-256, sha-512, sha-256-x2, etc.)
 * @returns {ops object array}
 */
function formatAsChainpointV3Ops (proof, op) {
  proof = proof.map((item) => {
    if (item.left) {
      return { l: item.left }
    } else {
      return { r: item.right }
    }
  })
  let ChainpointV3Ops = []
  for (let x = 0; x < proof.length; x++) {
    ChainpointV3Ops.push(proof[x])
    ChainpointV3Ops.push({ op: op })
  }
  return ChainpointV3Ops
}

// Take work off of the HASHES array and build Merkle tree
let aggregateAsync = async () => {
  // if the amqp channel is null (closed), processing should not continue, defer to next aggregateAsync call
  if (amqpChannel === null) return

  let hashesForTree = HASHES.splice(0, env.HASHES_PER_MERKLE_TREE)

  // create merkle tree only if there is at least one hash to process
  if (hashesForTree.length > 0) {
    // Collect and store the aggregation id, Merkle root, and proofs in a state object to send to state service
    let aggregationData = {}

    try {
      // clear the merkleTools instance to prepare for a new tree
      merkleTools.resetTree()

      // concatenate and hash the hash ids and hash values into new array
      let leaves = hashesForTree.map((hashObj) => {
        let hashIdBuffer = Buffer.from(`core_id:${hashObj.hash_id}`, 'utf8')
        let hashBuffer = Buffer.from(hashObj.hash, 'hex')
        let concatAndHashBuffer = crypto.createHash('sha256').update(Buffer.concat([hashIdBuffer, hashBuffer])).digest()

        if (hashObj.nist) { // add a concat and hash operation embedding NIST data into proof path
          let nistDataString = (`nist:${hashObj.nist}`)
          let nistDataBuffer = Buffer.from(nistDataString, 'utf8')
          return crypto.createHash('sha256').update(Buffer.concat([nistDataBuffer, concatAndHashBuffer])).digest('hex')
        } else { // no NIST data is available, return only the addition of the hashId
          return concatAndHashBuffer
        }
      })

      // Add every hash in hashesForTree to new Merkle tree
      merkleTools.addLeaves(leaves)
      merkleTools.makeTree()

      let treeSize = merkleTools.getLeafCount()

      aggregationData.agg_id = uuidv1()
      aggregationData.agg_root = merkleTools.getMerkleRoot().toString('hex')

      let proofData = []
      for (let x = 0; x < treeSize; x++) {
        // push the hash_id and corresponding proof onto the array, inserting the UUID concat/hash step at the beginning
        let proofDataItem = {}
        proofDataItem.hash_id = hashesForTree[x].hash_id
        proofDataItem.hash = hashesForTree[x].hash
        let proof = merkleTools.getProof(x)
        // only add the NIST item to the proof path if it was available and used in the tree calculation
        if (hashesForTree[x].nist) proof.unshift({ left: `nist:${hashesForTree[x].nist}` })
        proof.unshift({ left: `core_id:${hashesForTree[x].hash_id}` })
        proofDataItem.proof = formatAsChainpointV3Ops(proof, 'sha-256')
        proofData.push(proofDataItem)
      }
      aggregationData.proofData = proofData

      // queue state message containing state data for all hashes for this aggregation interval
      try {
        await amqpChannel.sendToQueue(env.RMQ_WORK_OUT_STATE_QUEUE, Buffer.from(JSON.stringify(aggregationData)), { persistent: true, type: 'aggregator' })
      } catch (error) {
        console.error(`${env.RMQ_WORK_OUT_STATE_QUEUE} publish message nacked`)
        throw new Error(error.message)
      }
    } catch (error) {
      console.error(`Aggregation error: ${error.message}`)
      // nack consumption of all original hash messages part of this aggregation event
      _.forEach(hashesForTree, (hashObj) => {
        if (hashObj.msg !== null) {
          amqpChannel.nack(hashObj.msg)
          console.error(env.RMQ_WORK_IN_AGG_QUEUE, 'consume message nacked')
        }
      })
      return
    }

    // The aggregation for this interval has completed sucessfully
    // ack consumption of all original hash messages part of this aggregation event
    _.forEach(hashesForTree, (hashObj) => {
      if (hashObj.msg !== null) {
        amqpChannel.ack(hashObj.msg)
      }
    })
  }
}

// This initalizes all the JS intervals that fire all aggregator events
function startIntervals () {
  console.log('starting intervals')

  // PERIODIC TIMERS

  setInterval(() => aggregateAsync(), env.AGGREGATION_INTERVAL)
}

/**
 * Opens an AMPQ connection and channel
 * Retry logic is included to handle losses of connection
 *
 * @param {string} connectionString - The connection URI for the RabbitMQ instance
 */
async function openRMQConnectionAsync (connectionString) {
  let rmqConnected = false
  while (!rmqConnected) {
    try {
      // connect to rabbitmq server
      let conn = await amqp.connect(connectionString)
      // create communication channel
      let chan = await conn.createConfirmChannel()
      // the connection and channel have been established
      chan.assertQueue(env.RMQ_WORK_IN_AGG_QUEUE, { durable: true })
      chan.assertQueue(env.RMQ_WORK_OUT_STATE_QUEUE, { durable: true })
      chan.prefetch(env.RMQ_PREFETCH_COUNT_AGG)
      // set 'amqpChannel' so that publishers have access to the channel
      amqpChannel = chan
      // Continuously load the HASHES from RMQ with hash objects to process)
      chan.consume(env.RMQ_WORK_IN_AGG_QUEUE, (msg) => {
        consumeHashMessage(msg)
      })
      // if the channel closes for any reason, attempt to reconnect
      conn.on('close', async () => {
        console.error('Connection to RMQ closed.  Reconnecting in 5 seconds...')
        amqpChannel = null
        // un-acked messaged will be requeued, so clear all work in progress
        HASHES = []
        await utils.sleep(5000)
        await openRMQConnectionAsync(connectionString)
      })
      console.log('RabbitMQ connection established')
      rmqConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish RabbitMQ connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init rabbitMQ
    await openRMQConnectionAsync(env.RABBITMQ_CONNECT_URI)
    // init interval functions
    startIntervals()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()

// export these functions for unit tests
module.exports = {
  getHASHES: function () { return HASHES },
  setHASHES: function (hashes) { HASHES = hashes },
  getAMQPChannel: function () { return amqpChannel },
  setAMQPChannel: (chan) => { amqpChannel = chan },
  openRMQConnectionAsync: openRMQConnectionAsync,
  consumeHashMessage: consumeHashMessage,
  aggregateAsync: aggregateAsync
}
