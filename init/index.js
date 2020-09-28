const {
  InitEthClient,
  InitEthEd25519,
  InitEthErc20,
  InitEthErc721,
  InitEthLocker,
  InitEthERC721Locker,
  InitEthProver,
} = require('./eth-contracts')
const { InitNearContracts } = require('./near-contracts')
const { InitNearTokenFactory } = require('./near-token-factory')

exports.InitEthEd25519 = InitEthEd25519
exports.InitEthErc20 = InitEthErc20
exports.InitEthErc721 = InitEthErc721
exports.InitEthLocker = InitEthLocker
exports.InitEthERC721Locker = InitEthERC721Locker
exports.InitEthClient = InitEthClient
exports.InitEthProver = InitEthProver
exports.InitNearContracts = InitNearContracts
exports.InitNearTokenFactory = InitNearTokenFactory
