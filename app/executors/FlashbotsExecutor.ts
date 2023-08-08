import { ContractWrapper, Executor, TxEnvelope } from '../Types.js';
import { fbReasonStringToHexString } from '../Utils.js';
import { ethers, utils } from 'ethers';
import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
  FlashbotsTransactionResponse,
  RelayResponseError,
} from '@flashbots/ethers-provider-bundle';
import { AbstractExecutor } from './AbstractExecutor.js';
import { printSolidityCustomError } from './ExecutorUtils.js';
import logger from '../services/Logger.js';

export class FlashbotsExecutor extends AbstractExecutor implements Executor {
  private fbRpc: string;
  private fbSigner: ethers.Wallet;
  private fbProvider: FlashbotsBundleProvider;

  protected toString(): string {
    return `(network: ${this.networkName}, rpc: ${this.fbRpc})`;
  }

  protected clog(level: string, ...args) {
    logger.log(level, `FlashbotsExecutor${this.toString()}: ${args.join(' ')}`);
  }

  protected err(...args): Error {
    return new Error(`FlashbotsExecutorError${this.toString()}: ${args.join(' ')}`);
  }

  constructor(
    networkName: string,
    rpc: string,
    genericProvider: ethers.providers.BaseProvider,
    workerSigner: ethers.Wallet,
    fbSigner: ethers.Wallet,
    agentContract: ContractWrapper,
  ) {
    super(agentContract);

    this.queue = [];
    this.networkName = networkName;
    this.workerSigner = workerSigner;
    this.fbRpc = rpc;
    this.fbSigner = fbSigner;
    this.genericProvider = genericProvider;
  }

  public async init() {
    this.fbProvider = await FlashbotsBundleProvider.create(
      this.genericProvider as ethers.providers.BaseProvider,
      this.fbSigner,
      this.fbRpc,
      this.networkName,
      // {chainId: 5, name: goerli}
    );
  }

  public async push(key: string, envelope: TxEnvelope) {
    if (!this.fbProvider) {
      throw this.err('Flashbots Provider misconfigured');
    }
    super.push(key, envelope);
  }

  protected async process(envelope: TxEnvelope) {
    const { tx } = envelope;
    let gasLimitEstimation;
    try {
      gasLimitEstimation = await this.genericProvider.estimateGas(tx);
    } catch (e) {
      // TODO (DANGER): hard limit
      tx.gasLimit = 700_000;
      tx.nonce = await this.genericProvider.getTransactionCount(this.workerSigner.address);
      let txSimulation;
      try {
        txSimulation = await this.genericProvider.call(tx);
        printSolidityCustomError(this.clog.bind(this), this.agentContract.decodeError, txSimulation, tx.data as string);
      } catch (e) {
        this.clog('error', 'TX node simulation error', e);
      }

      return;
    }

    tx.nonce = await this.genericProvider.getTransactionCount(this.workerSigner.address);
    tx.gasLimit = gasLimitEstimation.mul(15).div(10);
    this.clog('debug', `Signing tx with calldata=${tx.data} ...`);
    const signedBundle = await this.fbProvider.signBundle([
      {
        signer: this.workerSigner,
        transaction: tx,
      },
    ]);
    const txHash = utils.parseTransaction(signedBundle[0]).hash;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const targetBlock = (await this.genericProvider.getBlockNumber()) + 1;
      const simulation = await this.fbProvider.simulate(signedBundle, targetBlock);
      this.clog('debug', `Tx ${txHash}: The tx target block is ${targetBlock}...`);
      if ('error' in simulation) {
        const err = simulation as RelayResponseError;
        this.clog(
          'error',
          `Tx ${txHash}: Ignoring the tx due to the Flashbots simulation error: ${JSON.stringify(err.error)}`,
          JSON.stringify(utils.parseTransaction(signedBundle[0])),
        );
        return;
      } else if (simulation.firstRevert !== undefined) {
        // TODO: prettify data for logs
        console.log({ simulation });
        console.log({ results: simulation.results[0] });
        console.log('parsed reason', fbReasonStringToHexString(simulation.firstRevert['revert']));
        this.clog(
          'debug',
          `Tx ${txHash}: Ignoring the tx due to the Flashbots simulation revert: ${JSON.stringify(
            simulation.firstRevert,
          )}`,
        );
        return;
      }

      this.clog('debug', `Tx ${txHash}: Sending with a target block ${targetBlock}...`);
      const execution = await this.fbProvider.sendRawBundle(
        signedBundle,
        targetBlock,
        // TODO: minTime?
        // TODO: maxTime?
        { revertingTxHashes: [] },
      );
      if ('error' in execution) {
        const err = execution as RelayResponseError;
        this.clog('info', `Tx ${txHash}: Ignoring the tx due to execution error: ${err.error}`);
        return;
      }
      // TODO: how to check if gas price (priority fee) is too low???
      const waitRes = await (execution as FlashbotsTransactionResponse).wait();
      if (waitRes === FlashbotsBundleResolution.BundleIncluded) {
        this.clog('debug', `Tx ${txHash}: The bundle was included into the block ${targetBlock}`);
        break;
      } else if (waitRes === FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
        this.clog(
          'debug',
          `Tx ${txHash} was not included into the block ${targetBlock}. Will try to include it into the next block...`,
        );
      } else if (waitRes === FlashbotsBundleResolution.AccountNonceTooHigh) {
        throw this.err(`Tx ${txHash}: Error: FlashbotsBundleResolution.AccountNonceTooHigh`);
      } else {
        throw this.err('Unexpected bundle result:', waitRes);
      }
    }
  }
}
