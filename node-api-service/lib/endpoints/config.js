const env = require('../parse-env.js')('api')
const utils = require('../utils.js')
const fs = require('fs')

async function getCorePublicKeyListAsync () {
  // Currently, public keys are simply documented in a JSON file
  // which is read and returned here. In the future, this will be
  // replaced with a more robust system
  let pubKeyJSON = fs.readFileSync('./lib/public-keys.json')
  return JSON.parse(pubKeyJSON)
}

/**
 * GET /config handler
 *
 * Returns a configuration information object
 */
async function getConfigInfoV1Async (req, res, next) {
  res.send({
    chainpoint_stack_id: env.CHAINPOINT_STACK_ID,
    chainpoint_base_uri: env.CHAINPOINT_BASE_URI,
    anchor_btc: env.ANCHOR_BTC,
    anchor_eth: env.ANCHOR_ETH,
    proof_expire_minutes: env.PROOF_EXPIRE_MINUTES,
    get_proofs_max_rest: env.GET_PROOFS_MAX_REST,
    get_proofs_max_ws: env.GET_PROOFS_MAX_WS,
    post_hashes_max: env.POST_HASHES_MAX,
    post_verify_proofs_max: env.POST_VERIFY_PROOFS_MAX,
    get_calendar_blocks_max: env.GET_CALENDAR_BLOCKS_MAX,
    time: utils.formatDateISO8601NoMs(new Date()),
    public_keys: await getCorePublicKeyListAsync()
  })
  return next()
}

module.exports = {
  getConfigInfoV1Async: getConfigInfoV1Async
}