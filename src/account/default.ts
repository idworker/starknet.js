import { UDC, ZERO } from '../constants';
import { Provider, ProviderInterface } from '../provider';
import { Signer, SignerInterface } from '../signer';
import {
  Abi,
  AccountInvocationItem,
  AccountInvocations,
  AccountInvocationsFactoryDetails,
  AllowArray,
  BigNumberish,
  BlockIdentifier,
  CairoVersion,
  Call,
  DeclareAndDeployContractPayload,
  DeclareContractPayload,
  DeclareContractResponse,
  DeclareContractTransaction,
  DeclareDeployUDCResponse,
  DeployAccountContractPayload,
  DeployAccountContractTransaction,
  DeployContractResponse,
  DeployContractUDCResponse,
  DeployTransactionReceiptResponse,
  EstimateFee,
  EstimateFeeAction,
  EstimateFeeBulk,
  EstimateFeeDetails,
  EstimateFeeResponse,
  Invocation,
  Invocations,
  InvocationsSignerDetails,
  InvokeFunctionResponse,
  MultiDeployContractResponse,
  Nonce,
  ProviderOptions,
  Signature,
  SimulateTransactionDetails,
  SimulateTransactionResponse,
  TransactionType,
  TypedData,
  UniversalDeployerContractPayload,
} from '../types';
import { ETransactionVersion, ETransactionVersion3 } from '../types/api';
import { CallData } from '../utils/calldata';
import { extractContractHashes, isSierra } from '../utils/contract';
import { starkCurve } from '../utils/ec';
import { parseUDCEvent } from '../utils/events';
import { calculateContractAddressFromHash } from '../utils/hash';
import { toBigInt, toCairoBool } from '../utils/num';
import { parseContract } from '../utils/provider';
import {
  estimateFeeToBounds,
  estimatedFeeToMaxFee,
  formatSignature,
  randomAddress,
  toTransactionVersion,
  v3Details,
} from '../utils/stark';
import { getExecuteCalldata } from '../utils/transaction';
import { getMessageHash } from '../utils/typedData';
import { AccountInterface } from './interface';

export class Account extends Provider implements AccountInterface {
  public signer: SignerInterface;

  public address: string;

  public cairoVersion: CairoVersion;

  readonly transactionVersion: ETransactionVersion.V2 | ETransactionVersion.V3;

  constructor(
    providerOrOptions: ProviderOptions | ProviderInterface,
    address: string,
    pkOrSigner: Uint8Array | string | SignerInterface,
    cairoVersion?: CairoVersion,
    transactionVersion: ETransactionVersion.V2 | ETransactionVersion.V3 = ETransactionVersion.V2 // TODO: Discuss this, set to v2 for backward compatibility
  ) {
    super(providerOrOptions);
    this.address = address.toLowerCase();
    this.signer =
      typeof pkOrSigner === 'string' || pkOrSigner instanceof Uint8Array
        ? new Signer(pkOrSigner)
        : pkOrSigner;

    if (cairoVersion) {
      this.cairoVersion = cairoVersion.toString() as CairoVersion;
    }
    this.transactionVersion = transactionVersion;
  }

  // provided version or contract based preferred transactionVersion
  private getPreferredVersion(type2: ETransactionVersion, type3: ETransactionVersion) {
    if (this.transactionVersion === ETransactionVersion.V3) return type3;
    if (this.transactionVersion === ETransactionVersion.V2) return type2;

    return ETransactionVersion.V3;
  }

  public async getNonce(blockIdentifier?: BlockIdentifier): Promise<Nonce> {
    return super.getNonceForAddress(this.address, blockIdentifier);
  }

  private async getNonceSafe(nonce?: BigNumberish) {
    // Patch DEPLOY_ACCOUNT: RPC getNonce for non-existing address will result in error, on Sequencer it is '0x0'
    try {
      return toBigInt(nonce ?? (await this.getNonce()));
    } catch (error) {
      return 0n;
    }
  }

  /**
   * Retrieves the Cairo version from the network and sets `cairoVersion` if not already set in the constructor
   * @param classHash if provided detects Cairo version from classHash, otherwise from the account address
   */
  public async getCairoVersion(classHash?: string) {
    if (!this.cairoVersion) {
      const { cairo } = classHash
        ? await super.getContractVersion(undefined, classHash)
        : await super.getContractVersion(this.address);
      this.cairoVersion = cairo;
    }
    return this.cairoVersion;
  }

  public async estimateFee(
    calls: AllowArray<Call>,
    estimateFeeDetails: EstimateFeeDetails = {}
  ): Promise<EstimateFee> {
    return this.estimateInvokeFee(calls, estimateFeeDetails);
  }

  public async estimateInvokeFee(
    calls: AllowArray<Call>,
    details: EstimateFeeDetails = {}
  ): Promise<EstimateFee> {
    const { nonce: providedNonce, blockIdentifier, version: providedVersion } = details;

    const transactions = Array.isArray(calls) ? calls : [calls];
    const nonce = toBigInt(providedNonce ?? (await this.getNonce()));
    const version = toTransactionVersion(
      this.getPreferredVersion(ETransactionVersion.F1, ETransactionVersion.F3),
      providedVersion
    );
    const chainId = await this.getChainId();

    const signerDetails: InvocationsSignerDetails = {
      walletAddress: this.address,
      nonce,
      maxFee: ZERO,
      version,
      chainId,
      cairoVersion: await this.getCairoVersion(),
      ...v3Details(details),
    };

    const invocation = await this.buildInvocation(transactions, signerDetails);
    const estimateFeeResponse = await super.getInvokeEstimateFee(
      { ...invocation },
      { version, nonce, ...v3Details(details) },
      blockIdentifier
    );

    return {
      ...estimateFeeResponse,
      suggestedMaxFee: estimatedFeeToMaxFee(estimateFeeResponse.overall_fee),
      resourceBounds: estimateFeeToBounds(estimateFeeResponse),
    };
  }

  public async estimateDeclareFee(
    { contract, classHash: providedClassHash, casm, compiledClassHash }: DeclareContractPayload,
    details: EstimateFeeDetails = {}
  ): Promise<EstimateFee> {
    const { blockIdentifier, nonce: providedNonce, version: providedVersion } = details;
    const nonce = toBigInt(providedNonce ?? (await this.getNonce()));
    const version = toTransactionVersion(
      !isSierra(contract)
        ? ETransactionVersion.F1
        : this.getPreferredVersion(ETransactionVersion.F2, ETransactionVersion.F3),
      providedVersion
    );
    const chainId = await this.getChainId();

    const declareContractTransaction = await this.buildDeclarePayload(
      { classHash: providedClassHash, contract, casm, compiledClassHash },
      {
        nonce,
        chainId,
        version,
        walletAddress: this.address,
        maxFee: ZERO,
        cairoVersion: undefined, // unused parameter
        ...v3Details(details),
      }
    );

    const estimateFeeResponse = await super.getDeclareEstimateFee(
      declareContractTransaction,
      { version, nonce, ...v3Details(details) },
      blockIdentifier
    );

    return {
      ...estimateFeeResponse,
      suggestedMaxFee: estimatedFeeToMaxFee(estimateFeeResponse.overall_fee),
      resourceBounds: estimateFeeToBounds(estimateFeeResponse),
    };
  }

  public async estimateAccountDeployFee(
    {
      classHash,
      addressSalt = 0,
      constructorCalldata = [],
      contractAddress: providedContractAddress,
    }: DeployAccountContractPayload,
    details: EstimateFeeDetails = {}
  ): Promise<EstimateFee> {
    const { blockIdentifier, version: providedVersion } = details;
    const version = toTransactionVersion(
      this.getPreferredVersion(ETransactionVersion.F1, ETransactionVersion.F3),
      providedVersion
    ); // TODO: Can Cairo0 be deployed with F3 ?
    const nonce = ZERO; // DEPLOY_ACCOUNT transaction will have a nonce zero as it is the first transaction in the account
    const chainId = await this.getChainId();

    const payload = await this.buildAccountDeployPayload(
      { classHash, addressSalt, constructorCalldata, contractAddress: providedContractAddress },
      {
        nonce,
        chainId,
        version,
        walletAddress: this.address, // unused parameter
        maxFee: ZERO,
        cairoVersion: undefined, // unused parameter,
        ...v3Details(details),
      }
    );

    const estimateFeeResponse = await super.getDeployAccountEstimateFee(
      { ...payload },
      { version, nonce, ...v3Details(details) },
      blockIdentifier
    );

    return {
      ...estimateFeeResponse,
      suggestedMaxFee: estimatedFeeToMaxFee(estimateFeeResponse.overall_fee),
      resourceBounds: estimateFeeToBounds(estimateFeeResponse),
    };
  }

  public async estimateDeployFee(
    payload: UniversalDeployerContractPayload | UniversalDeployerContractPayload[],
    transactionsDetail: EstimateFeeDetails = {}
  ): Promise<EstimateFee> {
    const calls = this.buildUDCContractPayload(payload);
    return this.estimateInvokeFee(calls, transactionsDetail);
  }

  public async estimateFeeBulk(
    invocations: Invocations,
    details: EstimateFeeDetails = {}
  ): Promise<EstimateFeeBulk> {
    const { nonce, blockIdentifier } = details;
    const accountInvocations = await this.accountInvocationsFactory(invocations, {
      versions: [
        ETransactionVersion.F1, // non-sierra
        this.getPreferredVersion(ETransactionVersion.F2, ETransactionVersion.F3), // sierra
      ],
      nonce,
      blockIdentifier,
      ...v3Details(details),
    });

    const EstimateFeeResponseBulk = await super.getEstimateFeeBulk(accountInvocations, {
      blockIdentifier,
    });

    return [].concat(EstimateFeeResponseBulk as []).map((elem: EstimateFeeResponse) => {
      return {
        ...elem,
        suggestedMaxFee: estimatedFeeToMaxFee(elem.overall_fee),
        resourceBounds: estimateFeeToBounds(elem),
      };
    });
  }

  public async buildInvocation(
    call: Array<Call>,
    details: InvocationsSignerDetails
  ): Promise<Invocation> {
    const calldata = getExecuteCalldata(call, await this.getCairoVersion());
    const signature = await this.signer.signTransaction(call, details);

    return {
      contractAddress: this.address,
      calldata,
      signature,
      ...v3Details(details),
    };
  }

  public async execute(
    calls: AllowArray<Call>,
    abis: Abi[] | undefined = undefined,
    details: EstimateFeeDetails = {}
  ): Promise<InvokeFunctionResponse> {
    const transactions = Array.isArray(calls) ? calls : [calls];
    const nonce = toBigInt(details.nonce ?? (await this.getNonce()));
    const version = toTransactionVersion(
      this.getPreferredVersion(ETransactionVersion.V1, ETransactionVersion.V3), // TODO: does this depend on cairo version ?
      details.version
    );
    const maxFee =
      details.maxFee ??
      (await this.getSuggestedMaxFee(
        { type: TransactionType.INVOKE, payload: calls },
        {
          ...details,
          version,
        }
      ));

    const chainId = await this.getChainId();

    const signerDetails: InvocationsSignerDetails = {
      walletAddress: this.address,
      nonce,
      maxFee,
      version,
      chainId,
      cairoVersion: await this.getCairoVersion(),
      ...v3Details(details),
    };

    const signature = await this.signer.signTransaction(transactions, signerDetails, abis);

    const calldata = getExecuteCalldata(transactions, await this.getCairoVersion());

    return this.invokeFunction(
      { contractAddress: this.address, calldata, signature },
      {
        nonce,
        maxFee,
        version,
        ...v3Details(details),
      }
    );
  }

  /**
   * First check if contract is already declared, if not declare it
   * If contract already declared returned transaction_hash is ''.
   * Method will pass even if contract is already declared
   * @param transactionsDetail (optional)
   */
  public async declareIfNot(
    payload: DeclareContractPayload,
    transactionsDetail: EstimateFeeDetails = {}
  ): Promise<DeclareContractResponse> {
    const declareContractPayload = extractContractHashes(payload);
    try {
      await this.getClassByHash(declareContractPayload.classHash);
    } catch (error) {
      return this.declare(payload, transactionsDetail);
    }
    return {
      transaction_hash: '',
      class_hash: declareContractPayload.classHash,
    };
  }

  public async declare(
    payload: DeclareContractPayload,
    details: EstimateFeeDetails = {}
  ): Promise<DeclareContractResponse> {
    const declareContractPayload = extractContractHashes(payload);
    const { maxFee, nonce, version: providedVersion } = details;
    const version = toTransactionVersion(
      !isSierra(payload.contract)
        ? ETransactionVersion.V1
        : this.getPreferredVersion(ETransactionVersion.V2, ETransactionVersion.V3),
      providedVersion
    );

    const declareDetails: InvocationsSignerDetails = {
      nonce: toBigInt(nonce ?? (await this.getNonce())),
      maxFee:
        maxFee ??
        (await this.getSuggestedMaxFee(
          {
            type: TransactionType.DECLARE,
            payload: declareContractPayload,
          },
          {
            ...details,
            version,
          }
        )),
      version,
      chainId: await this.getChainId(),
      walletAddress: this.address,
      cairoVersion: undefined,
      ...v3Details(details),
    };

    const declareContractTransaction = await this.buildDeclarePayload(
      declareContractPayload,
      declareDetails
    );

    return this.declareContract(declareContractTransaction, declareDetails);
  }

  public async deploy(
    payload: UniversalDeployerContractPayload | UniversalDeployerContractPayload[],
    details: EstimateFeeDetails = {}
  ): Promise<MultiDeployContractResponse> {
    const params = [].concat(payload as []).map((it) => {
      const {
        classHash,
        salt,
        unique = true,
        constructorCalldata = [],
      } = it as UniversalDeployerContractPayload;

      const compiledConstructorCallData = CallData.compile(constructorCalldata);
      const deploySalt = salt ?? randomAddress();

      return {
        call: {
          contractAddress: UDC.ADDRESS,
          entrypoint: UDC.ENTRYPOINT,
          calldata: [
            classHash,
            deploySalt,
            toCairoBool(unique),
            compiledConstructorCallData.length,
            ...compiledConstructorCallData,
          ],
        },
        address: calculateContractAddressFromHash(
          unique ? starkCurve.pedersen(this.address, deploySalt) : deploySalt,
          classHash,
          compiledConstructorCallData,
          unique ? UDC.ADDRESS : 0
        ),
      };
    });

    const calls = params.map((it) => it.call);
    const addresses = params.map((it) => it.address);
    const invokeResponse = await this.execute(calls, undefined, details);

    return {
      ...invokeResponse,
      contract_address: addresses,
    };
  }

  public async deployContract(
    payload: UniversalDeployerContractPayload | UniversalDeployerContractPayload[],
    details: EstimateFeeDetails = {}
  ): Promise<DeployContractUDCResponse> {
    const deployTx = await this.deploy(payload, details);
    const txReceipt = await this.waitForTransaction(deployTx.transaction_hash);
    return parseUDCEvent(txReceipt as unknown as DeployTransactionReceiptResponse);
  }

  public async declareAndDeploy(
    payload: DeclareAndDeployContractPayload,
    details: EstimateFeeDetails = {}
  ): Promise<DeclareDeployUDCResponse> {
    const { constructorCalldata, salt, unique } = payload;
    let declare = await this.declareIfNot(payload, details);
    if (declare.transaction_hash !== '') {
      const tx = await this.waitForTransaction(declare.transaction_hash);
      declare = { ...declare, ...tx };
    }
    const deploy = await this.deployContract(
      { classHash: declare.class_hash, salt, unique, constructorCalldata },
      details
    );
    return { declare: { ...declare }, deploy };
  }

  public deploySelf = this.deployAccount;

  public async deployAccount(
    {
      classHash,
      constructorCalldata = [],
      addressSalt = 0,
      contractAddress: providedContractAddress,
    }: DeployAccountContractPayload,
    details: EstimateFeeDetails = {}
  ): Promise<DeployContractResponse> {
    const version = toTransactionVersion(
      this.getPreferredVersion(ETransactionVersion.V1, ETransactionVersion.V3),
      details.version
    );
    const nonce = ZERO; // DEPLOY_ACCOUNT transaction will have a nonce zero as it is the first transaction in the account
    const chainId = await this.getChainId();

    const compiledCalldata = CallData.compile(constructorCalldata);
    const contractAddress =
      providedContractAddress ??
      calculateContractAddressFromHash(addressSalt, classHash, compiledCalldata, 0);

    const maxFee =
      details.maxFee ??
      (await this.getSuggestedMaxFee(
        {
          type: TransactionType.DEPLOY_ACCOUNT,
          payload: {
            classHash,
            constructorCalldata: compiledCalldata,
            addressSalt,
            contractAddress,
          },
        },
        details
      ));

    const signature = await this.signer.signDeployAccountTransaction({
      classHash,
      constructorCalldata: compiledCalldata,
      contractAddress,
      addressSalt,
      chainId,
      maxFee,
      version,
      nonce,
      ...v3Details(details),
    });

    return this.deployAccountContract(
      { classHash, addressSalt, constructorCalldata, signature },
      {
        nonce,
        maxFee,
        version,
        ...v3Details(details),
      }
    );
  }

  public async signMessage(typedData: TypedData): Promise<Signature> {
    return this.signer.signMessage(typedData, this.address);
  }

  public async hashMessage(typedData: TypedData): Promise<string> {
    return getMessageHash(typedData, this.address);
  }

  public async verifyMessageHash(hash: BigNumberish, signature: Signature): Promise<boolean> {
    try {
      await this.callContract({
        contractAddress: this.address,
        entrypoint: 'isValidSignature',
        calldata: CallData.compile({
          hash: toBigInt(hash).toString(),
          signature: formatSignature(signature),
        }),
      });
      return true;
    } catch {
      return false;
    }
  }

  public async verifyMessage(typedData: TypedData, signature: Signature): Promise<boolean> {
    const hash = await this.hashMessage(typedData);
    return this.verifyMessageHash(hash, signature);
  }

  public async getSuggestedMaxFee(
    { type, payload }: EstimateFeeAction,
    details: EstimateFeeDetails
  ) {
    let feeEstimate: EstimateFee;

    switch (type) {
      case TransactionType.INVOKE:
        feeEstimate = await this.estimateInvokeFee(payload, details);
        break;

      case TransactionType.DECLARE:
        feeEstimate = await this.estimateDeclareFee(payload, details);
        break;

      case TransactionType.DEPLOY_ACCOUNT:
        feeEstimate = await this.estimateAccountDeployFee(payload, details);
        break;

      case TransactionType.DEPLOY:
        feeEstimate = await this.estimateDeployFee(payload, details);
        break;

      default:
        feeEstimate = {
          suggestedMaxFee: ZERO,
          overall_fee: ZERO,
          resourceBounds: estimateFeeToBounds(ZERO),
        };
        break;
    }

    return feeEstimate.suggestedMaxFee;
  }

  /**
   * will be renamed to buildDeclareContractTransaction
   */
  public async buildDeclarePayload(
    payload: DeclareContractPayload,
    details: InvocationsSignerDetails
  ): Promise<DeclareContractTransaction> {
    const { classHash, contract, compiledClassHash } = extractContractHashes(payload);
    const compressedCompiledContract = parseContract(contract);

    if (
      typeof compiledClassHash === 'undefined' &&
      Object.values(ETransactionVersion3).includes(details.version as any)
    ) {
      throw Error('V3 Transaction work with Cairo1 Contracts and require compiledClassHash');
    }

    const signature = await this.signer.signDeclareTransaction({
      ...details,
      classHash,
      compiledClassHash: compiledClassHash as string, // TODO: TS Nekuzi da v2 nemora imat a v3 mora i da je throvano ako nije definiran
      senderAddress: details.walletAddress,
      ...v3Details(details),
    });

    return {
      senderAddress: details.walletAddress,
      signature,
      contract: compressedCompiledContract,
      compiledClassHash,
    };
  }

  public async buildAccountDeployPayload(
    {
      classHash,
      addressSalt = 0,
      constructorCalldata = [],
      contractAddress: providedContractAddress,
    }: DeployAccountContractPayload,
    details: InvocationsSignerDetails
  ): Promise<DeployAccountContractTransaction> {
    const compiledCalldata = CallData.compile(constructorCalldata);
    const contractAddress =
      providedContractAddress ??
      calculateContractAddressFromHash(addressSalt, classHash, compiledCalldata, 0);

    const signature = await this.signer.signDeployAccountTransaction({
      ...details,
      classHash,
      contractAddress,
      addressSalt,
      constructorCalldata: compiledCalldata,
      ...v3Details(details),
    });

    return {
      classHash,
      addressSalt,
      constructorCalldata: compiledCalldata,
      signature,
    };
  }

  public buildUDCContractPayload(
    payload: UniversalDeployerContractPayload | UniversalDeployerContractPayload[]
  ): Call[] {
    const calls = [].concat(payload as []).map((it) => {
      const {
        classHash,
        salt = '0',
        unique = true,
        constructorCalldata = [],
      } = it as UniversalDeployerContractPayload;
      const compiledConstructorCallData = CallData.compile(constructorCalldata);

      return {
        contractAddress: UDC.ADDRESS,
        entrypoint: UDC.ENTRYPOINT,
        calldata: [
          classHash,
          salt,
          toCairoBool(unique),
          compiledConstructorCallData.length,
          ...compiledConstructorCallData,
        ],
      };
    });
    return calls;
  }

  public async simulateTransaction(
    invocations: Invocations,
    details: SimulateTransactionDetails = {}
  ): Promise<SimulateTransactionResponse> {
    const { nonce, blockIdentifier, skipValidate, skipExecute, version } = details;
    const accountInvocations = await this.accountInvocationsFactory(invocations, {
      versions: [
        toTransactionVersion(ETransactionVersion.V1), // non-sierra
        toTransactionVersion(
          this.getPreferredVersion(ETransactionVersion.V2, ETransactionVersion.V3),
          version
        ),
      ],
      nonce,
      blockIdentifier,
      ...v3Details(details),
    });

    return super.getSimulateTransaction(accountInvocations, {
      blockIdentifier,
      skipValidate,
      skipExecute,
    });
  }

  public async accountInvocationsFactory(
    invocations: Invocations,
    details: AccountInvocationsFactoryDetails
  ) {
    const { versions, nonce, blockIdentifier } = details;
    const version = versions[1]; // TODO: ovdje je bilo 0 prije a tribalo bi bit 1 LOL
    const safeNonce = await this.getNonceSafe(nonce);
    const chainId = await this.getChainId();

    // BULK ACTION FROM NEW ACCOUNT START WITH DEPLOY_ACCOUNT
    const tx0Payload: any = 'payload' in invocations[0] ? invocations[0].payload : invocations[0];
    const cairoVersion =
      invocations[0].type === TransactionType.DEPLOY_ACCOUNT
        ? await this.getCairoVersion(tx0Payload.classHash)
        : await this.getCairoVersion();

    return Promise.all(
      ([] as Invocations).concat(invocations).map(async (transaction, index: number) => {
        const txPayload: any = 'payload' in transaction ? transaction.payload : transaction;
        const signerDetails: InvocationsSignerDetails = {
          walletAddress: this.address,
          nonce: toBigInt(Number(safeNonce) + index),
          maxFee: ZERO,
          version,
          chainId,
          cairoVersion,
          ...v3Details(details),
        };
        const common = {
          type: transaction.type,
          version,
          nonce: toBigInt(Number(safeNonce) + index),
          blockIdentifier,
        };

        if (transaction.type === TransactionType.INVOKE) {
          const payload = await this.buildInvocation(
            ([] as Call[]).concat(txPayload),
            signerDetails
          );
          return {
            ...common,
            ...payload,
          } as AccountInvocationItem;
        }
        if (transaction.type === TransactionType.DECLARE) {
          signerDetails.version = !isSierra(txPayload.contract) ? versions[0] : versions[1];
          const payload = await this.buildDeclarePayload(txPayload, signerDetails);
          return {
            ...common,
            ...payload,
            version: signerDetails.version,
          } as AccountInvocationItem;
        }
        if (transaction.type === TransactionType.DEPLOY_ACCOUNT) {
          const payload = await this.buildAccountDeployPayload(txPayload, signerDetails);
          return {
            ...common,
            ...payload,
          } as AccountInvocationItem;
        }
        if (transaction.type === TransactionType.DEPLOY) {
          const calls = this.buildUDCContractPayload(txPayload);
          const payload = await this.buildInvocation(calls, signerDetails);
          return {
            ...common,
            ...payload,
            type: TransactionType.INVOKE,
          } as AccountInvocationItem;
        }
        throw Error(`accountInvocationsFactory: unsupported transaction type: ${transaction}`);
      })
    ) as Promise<AccountInvocations>;
  }

  public async getStarkName(
    address: BigNumberish = this.address, // default to the wallet address
    StarknetIdContract?: string
  ): Promise<string> {
    return super.getStarkName(address, StarknetIdContract);
  }
}
