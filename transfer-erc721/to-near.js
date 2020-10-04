const utils = require('ethereumjs-util')
const BN = require('bn.js')
const fs = require('fs')
const nearlib = require('near-api-js')
const {
  EthProofExtractor,
  receiptFromWeb3,
  logFromWeb3,
} = require('../eth-proof-extractor')
const { tokenAddressParam } = require('./deploy-token')
const { verifyAccount } = require('../rainbow/helpers')
const { NearMintableToken } = require('../near-mintable-token')
const { RainbowConfig } = require('../config')
const { EthOnNearClientContract } = require('../eth-on-near-client')
const { sleep, RobustWeb3, normalizeEthKey } = require('../rainbow/robust')

let initialCmd

class TransferExampleERC721ToNear {
  static showRetryAndExit() {
    console.log('Retry with command:')
    console.log(initialCmd)
    process.exit(1)
  }

  static async approve({
    robustWeb3,
    ethERC721Contract,
    amount,
    ethSenderAccount,
  }) {
    // Approve tokens for transfer.
    const lockerAddress = RainbowConfig.getParam('eth-erc721Locker-address')
    try {
      console.log(
        `Approving token transfer of token [${Number(amount)}] to ${lockerAddress}.`
      )
      await robustWeb3.callContract(
        ethERC721Contract,
        'approve',
        [lockerAddress, Number(amount)],
        {
          from: ethSenderAccount,
          gas: 5000000,
        }
      )
      console.log('Approved token transfer.')
      TransferExampleERC721ToNear.recordTransferLog({ finished: 'approve' })
    } catch (txRevertMessage) {
      console.log('Failed to approve.')
      console.log(txRevertMessage.toString())
      TransferExampleERC721ToNear.showRetryAndExit()
    }
  }

  static async lock({
    robustWeb3,
    ethTokenLockerContract,
    tokenAddress,
    amount,
    nearReceiverAccount,
    ethSenderAccount,
  }) {
    try {
      console.log(
        `Transferring token [${Number(
            amount
        )}] from the ERC721 account to the token locker account.`
      )
      const transaction = await robustWeb3.callContract(
        ethTokenLockerContract,
        'lockToken',
        [Number(amount), nearReceiverAccount],
        {
          from: ethSenderAccount,
          gas: 5000000,
        }
      )
      console.log(transaction)
      const lockedEvent = transaction.events.Locked
      console.log('Success tranfer to locker')
      TransferExampleERC721ToNear.recordTransferLog({
        finished: 'lock',
        lockedEvent,
      })
    } catch (txRevertMessage) {
      console.log('Failed to lock account.')
      console.log(txRevertMessage.toString())
      TransferExampleERC721ToNear.showRetryAndExit()
    }
  }

  static async findProof({ extractor, lockedEvent, web3 }) {
    const receipt = await extractor.extractReceipt(lockedEvent.transactionHash)
    const block = await extractor.extractBlock(receipt.blockNumber)
    const tree = await extractor.buildTrie(block)
    const proof = await extractor.extractProof(
      web3,
      block,
      tree,
      receipt.transactionIndex
    )
    let txLogIndex = -1

    let logFound = false
    let log
    for (let receiptLog of receipt.logs) {
      txLogIndex++
      const blockLogIndex = receiptLog.logIndex
      if (blockLogIndex === lockedEvent.logIndex) {
        logFound = true
        log = receiptLog
        break
      }
    }
    if (logFound) {
      TransferExampleERC721ToNear.recordTransferLog({
        finished: 'find-proof',
        proof,
        log,
        txLogIndex,
        receipt,
        lockedEvent,
        block,
      })
    } else {
      console.log(`Failed to find log for event ${lockedEvent}`)
      TransferExampleERC721ToNear.showRetryAndExit()
    }
  }

  static async waitBlockSafe({
    log,
    proof,
    receipt,
    txLogIndex,
    lockedEvent,
    block,
    ethOnNearClientContract,
  }) {
    const log_entry_data = logFromWeb3(log).serialize()
    const receipt_index = proof.txIndex
    const receipt_data = receiptFromWeb3(receipt).serialize()
    const header_data = proof.header_rlp
    const _proof = []
    for (const node of proof.receiptProof) {
      _proof.push(utils.rlp.encode(node))
    }

    const proof_locker = {
      log_index: txLogIndex,
      log_entry_data: log_entry_data,
      receipt_index: receipt_index,
      receipt_data: receipt_data,
      header_data: header_data,
      proof: _proof,
    }

    const new_owner_id = lockedEvent.returnValues.accountId
    const amount = lockedEvent.returnValues.amount
    console.log(
      `Transferring ${amount} tokens from ${lockedEvent.returnValues.token} ERC20. From ${lockedEvent.returnValues.sender} sender to ${new_owner_id} recipient`
    )

    const blockNumber = block.number
    // Wait until client accepts this block number.
    while (true) {
      // @ts-ignore
      const last_block_number = (
        await ethOnNearClientContract.last_block_number()
      ).toNumber()
      const is_safe = await ethOnNearClientContract.block_hash_safe(blockNumber)
      if (!is_safe) {
        const delay = 10
        console.log(
          `Near Client contract is currently at block ${last_block_number}. Waiting for block ${blockNumber} to be confirmed. Sleeping for ${delay} sec.`
        )
        await sleep(delay * 1000)
      } else {
        break
      }
    }
    TransferExampleERC721ToNear.recordTransferLog({
      finished: 'block-safe',
      proof_locker,
      new_owner_id,
    })
  }

  static async deposit({
    proof_locker,
    nearFactoryContract,
    nearFactoryContractBorsh,
    nearTokenContract,
    new_owner_id,
  }) {
    // @ts-ignore
    const old_balance = await nearTokenContract.get_balance({
      owner_id: new_owner_id,
    })
    console.log(
      `Balance of ${new_owner_id} before the transfer is ${old_balance}`
    )
    // @ts-ignore
    try {
      await nearFactoryContractBorsh.deposit(
        proof_locker,
        new BN('300000000000000'),
        // We need to attach tokens because minting increases the contract state, by <600 bytes, which
        // requires an additional 0.06 NEAR to be deposited to the account for state staking.
        // Note technically 0.0537 NEAR should be enough, but we round it up to stay on the safe side.
        new BN('100000000000000000000').mul(new BN('600'))
      )
      console.log('Transferred')
    } catch (e) {
      console.log('Deposit failed with error:')
      console.log(e)
      TransferExampleERC721ToNear.showRetryAndExit()
    }

    // @ts-ignore
    const new_balance = await nearTokenContract.get_balance({
      owner_id: new_owner_id,
    })
    console.log(
      `Balance of ${new_owner_id} after the transfer is ${new_balance}`
    )
    TransferExampleERC721ToNear.deleteTransferLog()
  }

  static recordTransferLog(obj) {
    fs.writeFileSync('transfer-eth-erc20-to-near.log.json', JSON.stringify(obj))
  }

  static parseBuffer(obj) {
    for (let i in obj) {
      if (obj[i] && obj[i].type === 'Buffer') {
        obj[i] = Buffer.from(obj[i].data)
      } else if (obj[i] && typeof obj[i] === 'object') {
        obj[i] = TransferExampleERC721ToNear.parseBuffer(obj[i])
      }
    }
    return obj
  }

  static loadTransferLog() {
    try {
      let log =
        JSON.parse(
          fs.readFileSync('transfer-eth-erc20-to-near.log.json').toString()
        ) || {}
      return TransferExampleERC721ToNear.parseBuffer(log)
    } catch (e) {
      return {}
    }
  }

  static deleteTransferLog() {
    try {
      fs.unlinkSync('transfer-eth-erc20-to-near.log.json')
    } catch (e) {
      console.log('Warning: failed to remove tranfer log')
    }
  }

  static async mint({
    proof_locker,
    nearTokenContract,
    nearTokenContractBorsh,
    new_owner_id,
  }) {
    // @ts-ignore
    // const old_balance = await nearTokenContract.get_balance({
    //   owner_id: new_owner_id,
    // })
    // console.log(
    //   `Balance of ${new_owner_id} before the transfer is ${old_balance}`
    // )
    console.log('minting the equiv 721 on the NEAR side');

    // @ts-ignore
    try {
      await nearTokenContractBorsh.mint(
          proof_locker,
          new BN('300000000000000'),
          // We need to attach tokens because minting increases the contract state, by <600 bytes, which
          // requires an additional 0.06 NEAR to be deposited to the account for state staking.
          // Note technically 0.0537 NEAR should be enough, but we round it up to stay on the safe side.
          new BN('100000000000000000000').mul(new BN('600'))
      )
      console.log('Transferred')
    } catch (e) {
      console.log('Mint failed with error:')
      console.log(e)
      TransferExampleERC721ToNear.showRetryAndExit()
    }

    // @ts-ignore
    // const new_balance = await nearTokenContract.get_owner({
    //   owner_id: new_owner_id,
    // })
    // console.log(
    //     `Balance of ${new_owner_id} after the transfer is ${new_balance}`
    // )
    TransferExampleERC721ToNear.deleteTransferLog()
  }

  static async execute(command) {
    initialCmd = command.parent.rawArgs.join(' ')
    let transferLog = TransferExampleERC721ToNear.loadTransferLog()
    const amount = command.amount
    const ethSenderSk = command.ethSenderSk
    const nearReceiverAccount = command.nearReceiverAccount
    const tokenAddress = command.tokenName
      ? RainbowConfig.getParam(tokenAddressParam(command.tokenName))
      : RainbowConfig.getParam('eth-erc721-address')

    console.log(`Using ETH address ${tokenAddress}`)

    // @ts-ignore
    let robustWeb3 = new RobustWeb3(RainbowConfig.getParam('eth-node-url'))
    let web3 = robustWeb3.web3
    let ethSenderAccount = web3.eth.accounts.privateKeyToAccount(
      normalizeEthKey(ethSenderSk)
    )
    web3.eth.accounts.wallet.add(ethSenderAccount)
    web3.eth.defaultAccount = ethSenderAccount.address
    ethSenderAccount = ethSenderAccount.address

    const ethERC721Contract = new web3.eth.Contract(
      // @ts-ignore
      JSON.parse(fs.readFileSync(RainbowConfig.getParam('eth-erc721-abi-path'))),
      tokenAddress
    )

    const nearMasterAccountId = RainbowConfig.getParam('near-master-account')
    console.log(nearMasterAccountId)
    // @ts-ignore
    const keyStore = new nearlib.keyStores.InMemoryKeyStore()
    await keyStore.setKey(
      RainbowConfig.getParam('near-network-id'),
      nearMasterAccountId,
      nearlib.KeyPair.fromString(RainbowConfig.getParam('near-master-sk'))
    )
    const near = await nearlib.connect({
      nodeUrl: RainbowConfig.getParam('near-node-url'),
      networkId: RainbowConfig.getParam('near-network-id'),
      masterAccount: nearMasterAccountId,
      deps: { keyStore: keyStore },
    })
    const nearMasterAccount = new nearlib.Account(
      near.connection,
      nearMasterAccountId
    )
    await verifyAccount(near, nearMasterAccountId)

    const nearTokenContract = new nearlib.Contract(
        nearMasterAccount,
        RainbowConfig.getParam('near-non-fun-token-account'),
        {
          changeMethods: ['new'],
          viewMethods: ['get_token_owner'],
        }
    )
    const nearTokenContractBorsh = new NearMintableToken(
        nearMasterAccount,
        RainbowConfig.getParam('near-non-fun-token-account')
    )
    await nearTokenContractBorsh.accessKeyInit()

    const extractor = new EthProofExtractor()
    extractor.initialize(RainbowConfig.getParam('eth-node-url'))

    const ethTokenLockerContract = new web3.eth.Contract(
      // @ts-ignore
      JSON.parse(
        fs.readFileSync(RainbowConfig.getParam('eth-erc721Locker-abi-path'))
      ),
      RainbowConfig.getParam('eth-erc721Locker-address')
    )

    const clientAccount = RainbowConfig.getParam('near-client-account')
    const ethOnNearClientContract = new EthOnNearClientContract(
      nearMasterAccount,
      clientAccount
    )

    if (transferLog.finished === undefined) {
      await TransferExampleERC721ToNear.approve({
        robustWeb3,
        ethERC721Contract,
        amount,
        ethSenderAccount,
      })
      transferLog = TransferExampleERC721ToNear.loadTransferLog()
    }
    if (transferLog.finished === 'approve') {
      await TransferExampleERC721ToNear.lock({
        robustWeb3,
        ethTokenLockerContract,
        tokenAddress,
        amount,
        nearReceiverAccount,
        ethSenderAccount,
      })
      transferLog = TransferExampleERC721ToNear.loadTransferLog()
    }
    if (transferLog.finished === 'lock') {
      await TransferExampleERC721ToNear.findProof({
        extractor,
        lockedEvent: transferLog.lockedEvent,
        web3,
      })
      transferLog = TransferExampleERC721ToNear.loadTransferLog()
    }
    if (transferLog.finished === 'find-proof') {
      await TransferExampleERC721ToNear.waitBlockSafe({
        ethOnNearClientContract,
        ...transferLog,
      })
      transferLog = TransferExampleERC721ToNear.loadTransferLog()
    }
    if (transferLog.finished === 'block-safe') {
      await TransferExampleERC721ToNear.mint({
        nearTokenContract,
        nearTokenContractBorsh,
        ...transferLog,
      })
    }

    try {
      // Only WebSocket provider can close.
      web3.currentProvider.connection.close()
    } catch (e) {}
    process.exit(0)
  }
}

exports.TransferExampleERC721ToNear = TransferExampleERC721ToNear
