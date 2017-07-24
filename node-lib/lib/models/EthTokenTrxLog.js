const Sequelize = require('sequelize-cockroachdb')

const envalid = require('envalid')

const env = envalid.cleanEnv(process.env, {
  COCKROACH_HOST: envalid.str({ devDefault: 'roach1', desc: 'CockroachDB host or IP' }),
  COCKROACH_PORT: envalid.num({ default: 26257, desc: 'CockroachDB port' }),
  COCKROACH_DB_NAME: envalid.str({ default: 'chainpoint', desc: 'CockroachDB name' }),
  COCKROACH_DB_USER: envalid.str({ default: 'chainpoint', desc: 'CockroachDB user' }),
  COCKROACH_DB_PASS: envalid.str({ default: '', desc: 'CockroachDB password' }),
  COCKROACH_ETH_TX_LOG_TABLE_NAME: envalid.str({ default: 'chainpoint_eth_tx_log', desc: 'CockroachDB table name' }),
  COCKROACH_TLS_CA_CRT: envalid.str({ devDefault: '', desc: 'CockroachDB TLS CA Cert' }),
  COCKROACH_TLS_CLIENT_KEY: envalid.str({ devDefault: '', desc: 'CockroachDB TLS Client Key' }),
  COCKROACH_TLS_CLIENT_CRT: envalid.str({ devDefault: '', desc: 'CockroachDB TLS Client Cert' })
})

// Connect to CockroachDB through Sequelize.
let sequelizeOptions = {
  dialect: 'postgres',
  host: env.COCKROACH_HOST,
  port: env.COCKROACH_PORT,
  logging: false
}

// Present TLS client certificate to production cluster
if (env.isProduction) {
  sequelizeOptions.dialectOptions = {
    ssl: {
      rejectUnauthorized: false,
      ca: env.COCKROACH_TLS_CA_CRT,
      key: env.COCKROACH_TLS_CLIENT_KEY,
      cert: env.COCKROACH_TLS_CLIENT_CRT
    }
  }
}

let sequelize = new Sequelize(env.COCKROACH_DB_NAME, env.COCKROACH_DB_USER, env.COCKROACH_DB_PASS, sequelizeOptions)

// Define the model and the table it will be stored in.
var EthTokenLog = sequelize.define(env.COCKROACH_ETH_TX_LOG_TABLE_NAME,
  {
    txId: {
      comment: 'The ethereum transaction id hash.',
      primaryKey: true,
      type: Sequelize.STRING,
      validate: {
        is: ['^[a-fA-F0-9:]{1,255}$', 'i']
      },
      field: 'tx_id',
      allowNull: false,
      unique: true
    },
    transactionIndex: {
      comment: 'Integer of the transactions index position log was created from',
      type: Sequelize.INTEGER,
      validate: {
        isInt: true
      },
      field: 'tx_index',
      allowNull: false
    },
    blockNumber: {
      comment: 'Block number where this log was in',
      type: Sequelize.INTEGER,
      validate: {
        isInt: true
      },
      field: 'tx_block',
      allowNull: false
    },
    fromAddress: {
      comment: 'The ethereum address where tokens were transferred from',
      type: Sequelize.STRING,
      field: 'from_address',
      allowNull: false
    },
    toAddress: {
      comment: 'The ethereum address where tokens were transferred to',
      type: Sequelize.STRING,
      field: 'to_address',
      allowNull: false
    },
    amount: {
      comment: 'The amount of TNT tokens sent in the transaction - in base units',
      type: Sequelize.BIGINT,
      field: 'amount',
      allowNull: false
    }
  },
  {
    // Disable the modification of table names; By default, sequelize will automatically
    // transform all passed model names (first parameter of define) into plural.
    // if you don't want that, set the following
    freezeTableName: true
  }
)

module.exports = {
  sequelize: sequelize,
  EthTokenLog: EthTokenLog
}
