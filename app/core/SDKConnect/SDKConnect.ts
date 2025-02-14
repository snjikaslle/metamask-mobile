import { StackNavigationProp } from '@react-navigation/stack';
import BackgroundTimer from 'react-native-background-timer';
import DefaultPreference from 'react-native-default-preference';
import { v1 as random } from 'uuid';
import AppConstants from '../AppConstants';

import {
  TransactionController,
  WalletDevice,
} from '@metamask/transaction-controller';
import { AppState } from 'react-native';
import Minimizer from 'react-native-minimizer';
import Device from '../../util/device';
import BackgroundBridge from '../BackgroundBridge/BackgroundBridge';
import Engine from '../Engine';
import getRpcMethodMiddleware, {
  ApprovalTypes,
} from '../RPCMethods/RPCMethodMiddleware';
import Logger from '../../util/Logger';

import { ApprovalController } from '@metamask/approval-controller';
import { KeyringController } from '@metamask/keyring-controller';
import { PreferencesController } from '@metamask/preferences-controller';
import {
  CommunicationLayerMessage,
  CommunicationLayerPreference,
  ConnectionStatus,
  EventType,
  MessageType,
  OriginatorInfo,
  RemoteCommunication,
} from '@metamask/sdk-communication-layer';
import { ethErrors } from 'eth-rpc-errors';
import { EventEmitter2 } from 'eventemitter2';
import Routes from '../../../app/constants/navigation/Routes';
import generateOTP from './utils/generateOTP.util';
import {
  wait,
  waitForEmptyRPCQueue,
  waitForKeychainUnlocked,
} from './utils/wait.util';

import {
  mediaDevices,
  MediaStream,
  MediaStreamTrack,
  registerGlobals,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';
import { Json } from '@metamask/controller-utils';
import RPCQueueManager from './RPCQueueManager';

export const MIN_IN_MS = 1000 * 60;
export const HOUR_IN_MS = MIN_IN_MS * 60;
export const DAY_IN_MS = HOUR_IN_MS * 24;
export const DEFAULT_SESSION_TIMEOUT_MS = 7 * DAY_IN_MS;

export interface ConnectionProps {
  id: string;
  otherPublicKey: string;
  origin: string;
  reconnect?: boolean;
  initialConnection?: boolean;
  originatorInfo?: OriginatorInfo;
  validUntil: number;
}
export interface ConnectedSessions {
  [id: string]: Connection;
}

export interface SDKSessions {
  [chanelId: string]: ConnectionProps;
}

export interface ApprovedHosts {
  [host: string]: number;
}

export interface approveHostProps {
  host: string;
  hostname: string;
  context?: string;
}

const webrtc = {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
  MediaStream,
  MediaStreamTrack,
  mediaDevices,
  registerGlobals,
};

export const TIMEOUT_PAUSE_CONNECTIONS = 20000;

export type SDKEventListener = (event: string) => void;

const CONNECTION_LOADING_EVENT = 'loading';

export const METHODS_TO_REDIRECT: { [method: string]: boolean } = {
  eth_requestAccounts: true,
  eth_sendTransaction: true,
  eth_signTransaction: true,
  eth_sign: true,
  personal_sign: true,
  eth_signTypedData: true,
  eth_signTypedData_v3: true,
  eth_signTypedData_v4: true,
  wallet_watchAsset: true,
  wallet_addEthereumChain: true,
  wallet_switchEthereumChain: true,
};

let wentBackMinimizer = false;

// eslint-disable-next-line
const { version } = require('../../../package.json');

export class Connection extends EventEmitter2 {
  channelId;
  remote: RemoteCommunication;
  requestsToRedirect: { [request: string]: boolean } = {};
  origin: string;
  host: string;
  originatorInfo?: OriginatorInfo;
  isReady = false;
  backgroundBridge?: BackgroundBridge;
  reconnect: boolean;
  /**
   * isResumed is used to manage the loading state.
   */
  isResumed = false;
  initialConnection: boolean;

  /**
   * Array of random number to use during reconnection and otp verification.
   */
  otps?: number[];

  /**
   * Should only be accesses via getter / setter.
   */
  private _loading = false;
  private approvalPromise?: Promise<unknown>;

  private rpcQueueManager: RPCQueueManager;

  approveHost: ({ host, hostname }: approveHostProps) => void;
  getApprovedHosts: (context: string) => ApprovedHosts;
  disapprove: (channelId: string) => void;
  revalidate: ({ channelId }: { channelId: string }) => void;
  isApproved: ({
    channelId,
  }: {
    channelId: string;
    context?: string;
  }) => boolean;
  onTerminate: ({ channelId }: { channelId: string }) => void;

  constructor({
    id,
    otherPublicKey,
    origin,
    reconnect,
    initialConnection,
    rpcQueueManager,
    approveHost,
    getApprovedHosts,
    disapprove,
    revalidate,
    isApproved,
    updateOriginatorInfos,
    onTerminate,
  }: ConnectionProps & {
    rpcQueueManager: RPCQueueManager;
    approveHost: ({ host, hostname }: approveHostProps) => void;
    getApprovedHosts: (context: string) => ApprovedHosts;
    disapprove: (channelId: string) => void;
    revalidate: ({ channelId }: { channelId: string }) => void;
    isApproved: ({ channelId }: { channelId: string }) => boolean;
    onTerminate: ({ channelId }: { channelId: string }) => void;
    updateOriginatorInfos: (params: {
      channelId: string;
      originatorInfo: OriginatorInfo;
    }) => void;
  }) {
    super();
    this.origin = origin;
    this.channelId = id;
    this.reconnect = reconnect || false;
    this.isResumed = false;
    this.initialConnection = initialConnection === true;
    this.host = `${AppConstants.MM_SDK.SDK_REMOTE_ORIGIN}${this.channelId}`;
    this.rpcQueueManager = rpcQueueManager;
    this.approveHost = approveHost;
    this.getApprovedHosts = getApprovedHosts;
    this.disapprove = disapprove;
    this.revalidate = revalidate;
    this.isApproved = isApproved;
    this.onTerminate = onTerminate;

    this.setLoading(true);

    this.remote = new RemoteCommunication({
      platform: AppConstants.MM_SDK.PLATFORM,
      communicationServerUrl: AppConstants.MM_SDK.SERVER_URL,
      communicationLayerPreference: CommunicationLayerPreference.SOCKET,
      otherPublicKey,
      webRTCLib: webrtc,
      reconnect,
      walletInfo: {
        type: 'MetaMask Mobile',
        version,
      },
      context: AppConstants.MM_SDK.PLATFORM,
      analytics: true,
      logging: {
        eciesLayer: false,
        keyExchangeLayer: false,
        remoteLayer: false,
        serviceLayer: false,
        // plaintext: true doesn't do anything unless using custom socket server.
        plaintext: true,
      },
      storage: {
        enabled: false,
      },
    });

    this.requestsToRedirect = {};

    this.sendMessage = this.sendMessage.bind(this);

    this.remote.on(EventType.CLIENTS_CONNECTED, () => {
      this.setLoading(true);
    });

    this.remote.on(EventType.CLIENTS_DISCONNECTED, () => {
      this.setLoading(false);
      // Disapprove a given host everytime there is a disconnection to prevent hijacking.
      if (!this.remote.isPaused()) {
        disapprove(this.channelId);
        this.initialConnection = false;
        this.otps = undefined;
      }
    });

    this.remote.on(
      EventType.CLIENTS_READY,
      async (clientsReadyMsg: { originatorInfo: OriginatorInfo }) => {
        const approvalController = (
          Engine.context as { ApprovalController: ApprovalController }
        ).ApprovalController;

        // clients_ready may be sent multple time (from sdk <0.2.0).
        const originatorInfo = clientsReadyMsg?.originatorInfo;
        const apiVersion = originatorInfo?.apiVersion;

        // backward compatibility with older sdk -- always first request approval
        if (!apiVersion) {
          // Cleanup previous pending permissions
          approvalController.clear(ethErrors.provider.userRejectedRequest());
          this.approvalPromise = undefined;
        }

        Logger.log(
          `SDKConnect::Connection - clients_ready channel=${this.channelId} apiVersion=${apiVersion}`,
          originatorInfo,
        );

        if (
          !this.initialConnection &&
          this.origin === AppConstants.DEEPLINKS.ORIGIN_QR_CODE
        ) {
          approvalController.clear(ethErrors.provider.userRejectedRequest());
          this.approvalPromise = undefined;

          if (!this.otps) {
            this.otps = generateOTP();
          }
          this.sendMessage({
            type: MessageType.OTP,
            otpAnswer: this.otps?.[0],
          });
          // Prevent auto approval if metamask is killed and restarted
          disapprove(this.channelId);

          // Always need to re-approve connection first.
          await this.checkPermissions();
        } else if (
          !this.initialConnection &&
          this.origin === AppConstants.DEEPLINKS.ORIGIN_DEEPLINK
        ) {
          // Deeplink channels are automatically approved on re-connection.
          const hostname =
            AppConstants.MM_SDK.SDK_REMOTE_ORIGIN + this.channelId;
          approveHost({
            host: hostname,
            hostname,
            context: 'clients_ready',
          });
          this.remote
            .sendMessage({ type: 'authorized' as MessageType })
            .catch((err) => {
              console.warn(
                `SDKConnect::Connection failed to send 'authorized'`,
                err,
              );
            });
        }

        // Make sure we only initialize the bridge when originatorInfo is received.
        if (!originatorInfo) {
          return;
        }
        this.originatorInfo = originatorInfo;
        updateOriginatorInfos({ channelId: this.channelId, originatorInfo });

        if (this.isReady) {
          // Re-send otp message in case client didnd't receive disconnection.
          return;
        }

        this.setupBridge(originatorInfo);
        this.isReady = true;
      },
    );

    this.remote.on(
      EventType.MESSAGE,
      async (message: CommunicationLayerMessage) => {
        if (!this.isReady) {
          return;
        }

        // handle termination message
        if (message.type === MessageType.TERMINATE) {
          // Delete connection from storage
          this.onTerminate({ channelId: this.channelId });
          return;
        }

        // ignore anything other than RPC methods.
        if (!message.method || !message.id) {
          return;
        }

        let needsRedirect = METHODS_TO_REDIRECT[message?.method] ?? false;
        // reset wentBack state to allow Minimizer.goBack()
        wentBackMinimizer = false;

        if (needsRedirect) {
          this.requestsToRedirect[message?.id] = true;
        }

        // Keep this section only for backward compatibility otherwise metamask doesn't redirect properly.
        if (
          !this.originatorInfo?.apiVersion &&
          !needsRedirect &&
          // this.originatorInfo?.platform !== 'unity' &&
          message?.method === 'metamask_getProviderState'
        ) {
          // Manually force redirect if apiVersion isn't defined for backward compatibility
          needsRedirect = true;
          this.requestsToRedirect[message?.id] = true;
        }

        const keyringController = (
          Engine.context as { KeyringController: KeyringController }
        ).KeyringController;
        await waitForKeychainUnlocked({ keyringController });

        // Check if channel is permitted
        try {
          if (needsRedirect) {
            await this.checkPermissions(message);
            this.setLoading(false);
            // Special case for eth_requestAccount, doens't need to queue because it comes from apporval request.
            this.rpcQueueManager.add({
              id: (message.id as string) ?? 'unknown',
              method: message.method,
            });
          }
        } catch (error) {
          // Approval failed - redirect to app with error.
          this.sendMessage({
            data: {
              error,
              id: message.id,
              jsonrpc: '2.0',
            },
            name: 'metamask-provider',
          });
          this.approvalPromise = undefined;
          return;
        }

        // We have to implement this method here since the eth_sendTransaction in Engine is not working because we can't send correct origin
        if (message.method === 'eth_sendTransaction') {
          if (
            !(
              message.params &&
              Array.isArray(message?.params) &&
              message.params.length > 0
            )
          ) {
            throw new Error('Invalid message format');
          }

          const transactionController = (
            Engine.context as { TransactionController: TransactionController }
          ).TransactionController;
          try {
            const hash = await (
              await transactionController.addTransaction(
                message.params[0],
                this.originatorInfo?.url
                  ? AppConstants.MM_SDK.SDK_REMOTE_ORIGIN +
                      this.originatorInfo?.url
                  : undefined,
                WalletDevice.MM_MOBILE,
              )
            ).result;
            this.sendMessage({
              data: {
                id: message.id,
                jsonrpc: '2.0',
                result: hash,
              },
              name: 'metamask-provider',
            });
          } catch (error) {
            this.sendMessage({
              data: {
                error,
                id: message.id,
                jsonrpc: '2.0',
              },
              name: 'metamask-provider',
            });
          }
          return;
        }

        // Add some delay, otherwise in some rare cases, the ui may not have had time ot initialize and modal doesn't show.
        setTimeout(() => {
          this.backgroundBridge?.onMessage({
            name: 'metamask-provider',
            data: message,
            origin: 'sdk',
          });
        }, 100);
      },
    );
  }

  public connect({ withKeyExchange }: { withKeyExchange: boolean }) {
    this.remote.connectToChannel(this.channelId, withKeyExchange);
    this.setLoading(true);
    if (withKeyExchange) {
      this.remote.on(EventType.CLIENTS_WAITING, () => {
        // Always disconnect - this should not happen, DAPP should always init the connection.
        // A new channelId should be created after connection is removed.
        // On first launch reconnect is set to false even if there was a previous existing connection in another instance.
        // To avoid hanging on the socket forever, we automatically close it after 5seconds.
        this.removeConnection({ terminate: false });
      });
    }
  }

  setLoading(loading: boolean) {
    this._loading = loading;
    this.emit(CONNECTION_LOADING_EVENT, { loading });
  }

  getLoading() {
    return this._loading;
  }

  private setupBridge(originatorInfo: OriginatorInfo) {
    if (this.backgroundBridge) {
      return;
    }
    this.backgroundBridge = new BackgroundBridge({
      webview: null,
      isMMSDK: true,
      url: originatorInfo?.url || originatorInfo?.title,
      isRemoteConn: true,
      sendMessage: this.sendMessage,
      getApprovedHosts: () => this.getApprovedHosts('backgroundBridge'),
      remoteConnHost: this.host,
      getRpcMethodMiddleware: ({
        getProviderState,
      }: {
        hostname: string;
        getProviderState: any;
      }) =>
        getRpcMethodMiddleware({
          hostname: this.host,
          getProviderState,
          isMMSDK: true,
          navigation: null, //props.navigation,
          getApprovedHosts: () => this.getApprovedHosts('rpcMethodMiddleWare'),
          setApprovedHosts: (hostname: string) => {
            this.approveHost({
              host: hostname,
              hostname,
              context: 'setApprovedHosts',
            });
          },
          approveHost: (approveHostname) =>
            this.approveHost({
              host: this.host,
              hostname: approveHostname,
              context: 'rpcMethodMiddleWare',
            }),
          // Website info
          url: {
            current: originatorInfo?.url,
          },
          title: {
            current: originatorInfo?.title,
          },
          icon: { current: undefined },
          // Bookmarks
          isHomepage: () => false,
          // Show autocomplete
          fromHomepage: { current: false },
          // Wizard
          wizardScrollAdjusted: { current: false },
          tabId: '',
          isWalletConnect: false,
          analytics: {
            isRemoteConn: true,
            platform:
              originatorInfo?.platform ?? AppConstants.MM_SDK.UNKNOWN_PARAM,
          },
          toggleUrlModal: () => null,
          injectHomePageScripts: () => null,
        }),
      isMainFrame: true,
      isWalletConnect: false,
      wcRequestActions: undefined,
    });
  }

  /**
   * Check if current channel has been allowed.
   *
   * @param message
   * @returns {boolean} true when host is approved or user approved the request.
   * @throws error if the user reject approval request.
   */
  private async checkPermissions(
    _message?: CommunicationLayerMessage,
  ): Promise<boolean> {
    // only ask approval if needed
    const approved = this.isApproved({
      channelId: this.channelId,
      context: 'checkPermission',
    });

    const preferencesController = (
      Engine.context as { PreferencesController: PreferencesController }
    ).PreferencesController;
    const selectedAddress = preferencesController.state.selectedAddress;

    if (approved && selectedAddress) {
      return true;
    }

    const approvalController = (
      Engine.context as { ApprovalController: ApprovalController }
    ).ApprovalController;

    if (this.approvalPromise) {
      // Wait for result and clean the promise afterwards.
      await this.approvalPromise;
      this.approvalPromise = undefined;
      return true;
    }

    if (!this.initialConnection && AppConstants.DEEPLINKS.ORIGIN_DEEPLINK) {
      this.revalidate({ channelId: this.channelId });
    }

    this.approvalPromise = approvalController.add({
      origin: this.origin,
      type: ApprovalTypes.CONNECT_ACCOUNTS,
      requestData: {
        hostname: this.originatorInfo?.title ?? '',
        pageMeta: {
          channelId: this.channelId,
          reconnect: !this.initialConnection,
          origin: this.origin,
          url: this.originatorInfo?.url ?? '',
          title: this.originatorInfo?.title ?? '',
          icon: this.originatorInfo?.icon ?? '',
          otps: this.otps ?? [],
          apiVersion: this.originatorInfo?.apiVersion,
          analytics: {
            request_source: AppConstants.REQUEST_SOURCES.SDK_REMOTE_CONN,
            request_platform:
              this.originatorInfo?.platform ??
              AppConstants.MM_SDK.UNKNOWN_PARAM,
          },
        } as Json,
      },
      id: random(),
    });

    await this.approvalPromise;
    // Clear previous permissions if already approved.
    this.revalidate({ channelId: this.channelId });
    this.approvalPromise = undefined;
    this.remote
      .sendMessage({ type: 'authorized' as MessageType })
      .catch((err) => {
        console.warn(`SDKConnect::Connection failed to send 'authorized'`, err);
      });
    return true;
  }

  pause() {
    this.remote.pause();
  }

  resume() {
    this.remote.resume();
    this.isResumed = true;
    this.setLoading(false);
  }

  disconnect({ terminate }: { terminate: boolean }) {
    if (terminate) {
      this.remote
        .sendMessage({
          type: MessageType.TERMINATE,
        })
        .catch((err) => {
          console.warn(`SDKConnect::Connection failed to send terminate`, err);
        });
    }
    this.remote.disconnect();
  }

  removeConnection({ terminate }: { terminate: boolean }) {
    this.isReady = false;
    this.disconnect({ terminate });
    this.backgroundBridge?.onDisconnect();
    this.setLoading(false);
  }

  sendMessage(msg: any) {
    const needsRedirect = this.requestsToRedirect[msg?.data?.id];
    const rpcMethod = this.rpcQueueManager.getId(msg?.data?.id);
    this.remote.sendMessage(msg).catch((err) => {
      console.warn(`SDKConnect::Connection::sendMessage failed to send`, err);
    });
    this.setLoading(false);

    if (!needsRedirect) return;

    this.rpcQueueManager.remove(msg?.data?.id);
    delete this.requestsToRedirect[msg?.data?.id];

    if (this.origin === AppConstants.DEEPLINKS.ORIGIN_QR_CODE) return;

    waitForEmptyRPCQueue(this.rpcQueueManager)
      .then(async () => {
        if (wentBackMinimizer) {
          // Skip, already went back.
          return;
        }

        // No need to wait on eth_requestAccounts
        if (rpcMethod !== 'eth_requestAccounts') {
          // Add delay for the user to see feedback modal
          await wait(1000);
        }

        Minimizer.goBack();
      })
      .catch((err) => {
        console.warn(
          `SDKConnect::Connection::sendMessage error while waiting for empty rpc queue`,
          err,
        );
      });
  }
}

export class SDKConnect extends EventEmitter2 {
  private static instance: SDKConnect;

  private navigation?: StackNavigationProp<{
    [route: string]: { screen: string };
  }>;
  private reconnected = false;
  private _initialized = false;
  private timeout?: number;
  private initTimeout?: number;
  private paused = false;
  private appState?: string;
  private connected: ConnectedSessions = {};
  private connections: SDKSessions = {};
  private connecting: { [channelId: string]: boolean } = {};
  private approvedHosts: ApprovedHosts = {};
  private sdkLoadingState: { [channelId: string]: boolean } = {};
  // Contains the list of hosts that have been set to not persist "Do Not Remember" on account approval modal.
  // This should only affect web connection from qr-code.
  private disabledHosts: ApprovedHosts = {};
  private rpcqueueManager = new RPCQueueManager();

  private SDKConnect() {
    // Keep empty to manage singleton
  }

  public async connectToChannel({
    id,
    otherPublicKey,
    origin,
  }: ConnectionProps) {
    const existingConnection = this.connected[id] !== undefined;

    if (existingConnection && !this.paused) {
      // if paused --- wait for resume --- otherwise reconnect.
      await this.reconnect({ channelId: id, context: 'connectToChannel' });
      return;
    }

    Logger.log(
      `SDKConnect::connectToChannel - paused=${this.paused} connecting to channel ${id} from '${origin}'`,
      otherPublicKey,
    );

    this.connecting[id] = true;
    this.connections[id] = {
      id,
      otherPublicKey,
      origin,
      validUntil: Date.now() + DEFAULT_SESSION_TIMEOUT_MS,
    };

    const initialConnection = this.approvedHosts[id] === undefined;

    this.connected[id] = new Connection({
      ...this.connections[id],
      initialConnection,
      rpcQueueManager: this.rpcqueueManager,
      updateOriginatorInfos: this.updateOriginatorInfos.bind(this),
      approveHost: this._approveHost.bind(this),
      disapprove: this.disapproveChannel.bind(this),
      getApprovedHosts: this.getApprovedHosts.bind(this),
      revalidate: this.revalidateChannel.bind(this),
      isApproved: this.isApproved.bind(this),
      onTerminate: ({
        channelId,
        sendTerminate,
      }: {
        channelId: string;
        sendTerminate?: boolean;
      }) => {
        this.removeChannel(channelId, sendTerminate);
      },
    });
    // Make sure to watch event before you connect
    this.watchConnection(this.connected[id]);
    await DefaultPreference.set(
      AppConstants.MM_SDK.SDK_CONNECTIONS,
      JSON.stringify(this.connections),
    );
    // Initialize connection
    this.connected[id].connect({
      withKeyExchange: true,
    });
    this.connecting[id] = false;
    this.emit('refresh');
  }

  private watchConnection(connection: Connection) {
    connection.remote.on(
      EventType.CONNECTION_STATUS,
      (connectionStatus: ConnectionStatus) => {
        if (connectionStatus === ConnectionStatus.TERMINATED) {
          this.removeChannel(connection.channelId);
        }
      },
    );

    connection.remote.on(EventType.CLIENTS_DISCONNECTED, () => {
      const host = AppConstants.MM_SDK.SDK_REMOTE_ORIGIN + connection.channelId;
      // Prevent disabled connection ( if user chose do not remember session )
      if (this.disabledHosts[host] !== undefined) {
        this.removeChannel(connection.channelId, true);
        this.updateSDKLoadingState({
          channelId: connection.channelId,
          loading: false,
        }).catch((err) => {
          console.warn(
            `SDKConnect::watchConnection can't update SDK loading state`,
            err,
          );
        });
      }
    });

    connection.on(CONNECTION_LOADING_EVENT, (event: { loading: boolean }) => {
      const channelId = connection.channelId;
      const { loading } = event;
      this.updateSDKLoadingState({ channelId, loading }).catch((err) => {
        console.warn(
          `SDKConnect::watchConnection can't update SDK loading state`,
          err,
        );
      });
    });
  }

  public async updateSDKLoadingState({
    channelId,
    loading,
  }: {
    channelId: string;
    loading: boolean;
  }) {
    const keyringController = (
      Engine.context as { KeyringController: KeyringController }
    ).KeyringController;
    await waitForKeychainUnlocked({ keyringController });

    if (loading === true) {
      this.sdkLoadingState[channelId] = true;
    } else {
      delete this.sdkLoadingState[channelId];
    }

    const loadingSessions = Object.keys(this.sdkLoadingState).length;
    if (loadingSessions > 0) {
      this.navigation?.navigate(Routes.MODAL.ROOT_MODAL_FLOW, {
        screen: Routes.SHEET.SDK_LOADING,
      });
    } else {
      const currentRoute = (this.navigation as any).getCurrentRoute?.()
        ?.name as string;
      if (currentRoute === Routes.SHEET.SDK_LOADING) {
        this.navigation?.goBack();
      }
    }
  }

  public async hideLoadingState() {
    this.sdkLoadingState = {};
    const currentRoute = (this.navigation as any).getCurrentRoute?.()
      ?.name as string;
    if (currentRoute === Routes.SHEET.SDK_LOADING) {
      this.navigation?.goBack();
    }
  }

  public updateOriginatorInfos({
    channelId,
    originatorInfo,
  }: {
    channelId: string;
    originatorInfo: OriginatorInfo;
  }) {
    this.connections[channelId].originatorInfo = originatorInfo;
    DefaultPreference.set(
      AppConstants.MM_SDK.SDK_CONNECTIONS,
      JSON.stringify(this.connections),
    ).catch((err) => {
      throw err;
    });
  }

  public resume({ channelId }: { channelId: string }) {
    const session = this.connected[channelId]?.remote;

    if (session && !session?.isConnected() && !this.connecting[channelId]) {
      Logger.log(`SDKConnect::resume - channel=${channelId}`);
      this.connecting[channelId] = true;
      this.connected[channelId].resume();
      this.connecting[channelId] = false;
    }
  }

  async reconnect({
    channelId,
    context,
  }: {
    channelId: string;
    context?: string;
  }) {
    if (this.paused) {
      return;
    }

    if (this.connecting[channelId]) {
      return;
    }

    if (!this.connections[channelId]) {
      return;
    }

    const existingConnection = this.connected[channelId];

    if (existingConnection) {
      const connected = existingConnection?.remote.isConnected();
      const ready = existingConnection?.remote.isReady();
      if (ready && connected) {
        // Ignore reconnection -- already ready to process messages.
        return;
      }

      if (ready || connected) {
        // Try to recover the connection while pinging.
        existingConnection.remote.ping();
        return;
      }
    }

    Logger.log(
      `SDKConnect::reconnect - channel=${channelId} context=${context} (existing=${
        existingConnection !== undefined
      })`,
    );

    const connection = this.connections[channelId];
    this.connecting[channelId] = true;
    this.connected[channelId] = new Connection({
      ...connection,
      reconnect: true,
      initialConnection: false,
      rpcQueueManager: this.rpcqueueManager,
      approveHost: this._approveHost.bind(this),
      disapprove: this.disapproveChannel.bind(this),
      getApprovedHosts: this.getApprovedHosts.bind(this),
      revalidate: this.revalidateChannel.bind(this),
      isApproved: this.isApproved.bind(this),
      updateOriginatorInfos: this.updateOriginatorInfos.bind(this),
      // eslint-disable-next-line @typescript-eslint/no-shadow
      onTerminate: ({ channelId }) => {
        this.removeChannel(channelId);
      },
    });
    this.connected[channelId].connect({
      withKeyExchange: true,
    });
    this.watchConnection(this.connected[channelId]);
    this.connecting[channelId] = false;
    this.emit('refresh');
  }

  async reconnectAll() {
    if (this.reconnected) {
      return;
    }

    const channelIds = Object.keys(this.connections);
    channelIds.forEach((channelId) => {
      if (channelId) {
        this.reconnect({ channelId, context: 'reconnectAll' }).catch((err) => {
          console.warn(
            `SDKConnect::reconnectAll error reconnecting to ${channelId}`,
            err,
          );
        });
      }
    });
    this.reconnected = true;
  }

  setSDKSessions(sdkSessions: SDKSessions) {
    this.connections = sdkSessions;
  }

  public pause() {
    if (this.paused) return;

    for (const id in this.connected) {
      this.connected[id].pause();
    }
    this.paused = true;
    this.connecting = {};
  }

  /**
   * Invalidate a channel/session by preventing future connection to be established.
   * Instead of removing the channel, it creates sets the session to timeout on next
   * connection which will remove it while conitnuing current session.
   *
   * @param channelId
   */
  public invalidateChannel({ channelId }: { channelId: string }) {
    const host = AppConstants.MM_SDK.SDK_REMOTE_ORIGIN + channelId;
    this.disabledHosts[host] = 0;
    delete this.approvedHosts[host];
    delete this.connecting[channelId];
    delete this.connections[channelId];
    DefaultPreference.set(
      AppConstants.MM_SDK.SDK_APPROVEDHOSTS,
      JSON.stringify(this.approvedHosts),
    ).catch((err) => {
      throw err;
    });
    DefaultPreference.set(
      AppConstants.MM_SDK.SDK_CONNECTIONS,
      JSON.stringify(this.connections),
    ).catch((err) => {
      throw err;
    });
  }

  public removeChannel(channelId: string, sendTerminate?: boolean) {
    if (this.connected[channelId]) {
      try {
        this.connected[channelId].removeConnection({
          terminate: sendTerminate ?? false,
        });
      } catch (err) {
        // Ignore error
      }

      delete this.connected[channelId];
      delete this.connections[channelId];
      delete this.connecting[channelId];
      delete this.approvedHosts[
        AppConstants.MM_SDK.SDK_REMOTE_ORIGIN + channelId
      ];
      delete this.disabledHosts[
        AppConstants.MM_SDK.SDK_REMOTE_ORIGIN + channelId
      ];
      DefaultPreference.set(
        AppConstants.MM_SDK.SDK_CONNECTIONS,
        JSON.stringify(this.connections),
      ).catch((err) => {
        throw err;
      });
      DefaultPreference.set(
        AppConstants.MM_SDK.SDK_APPROVEDHOSTS,
        JSON.stringify(this.approvedHosts),
      ).catch((err) => {
        throw err;
      });
    }
    this.emit('refresh');
  }

  public async removeAll() {
    for (const id in this.connections) {
      this.removeChannel(id, true);
    }
    // Also remove approved hosts that may have been skipped.
    this.approvedHosts = {};
    this.disabledHosts = {};
    this.connections = {};
    this.connected = {};
    this.connecting = {};
    this.paused = false;
    await DefaultPreference.clear(AppConstants.MM_SDK.SDK_CONNECTIONS);
    await DefaultPreference.clear(AppConstants.MM_SDK.SDK_APPROVEDHOSTS);
  }

  public getConnected() {
    return this.connected;
  }

  public getConnections() {
    return this.connections;
  }

  public getApprovedHosts(_context?: string) {
    return this.approvedHosts || {};
  }

  public disapproveChannel(channelId: string) {
    const hostname = AppConstants.MM_SDK.SDK_REMOTE_ORIGIN + channelId;
    delete this.approvedHosts[hostname];
  }

  public async revalidateChannel({ channelId }: { channelId: string }) {
    const hostname = AppConstants.MM_SDK.SDK_REMOTE_ORIGIN + channelId;
    this._approveHost({
      host: hostname,
      hostname,
      context: 'revalidateChannel',
    });
  }

  public isApproved({ channelId }: { channelId: string; context?: string }) {
    const hostname = AppConstants.MM_SDK.SDK_REMOTE_ORIGIN + channelId;
    const isApproved = this.approvedHosts[hostname] !== undefined;
    // possible future feature to add multiple approval parameters per channel.
    return isApproved;
  }

  private _approveHost({ host }: approveHostProps) {
    if (this.disabledHosts[host]) {
      // Might be useful for future feature.
    } else {
      // Host is approved for 24h.
      this.approvedHosts[host] = Date.now() + DAY_IN_MS;
      // Prevent disabled hosts from being persisted.
      DefaultPreference.set(
        AppConstants.MM_SDK.SDK_APPROVEDHOSTS,
        JSON.stringify(this.approvedHosts),
      ).catch((err) => {
        throw err;
      });
    }
    this.emit('refresh');
  }

  private async _handleAppState(appState: string) {
    // Prevent double handling same app state
    if (this.appState === appState) {
      return;
    }

    this.appState = appState;
    if (appState === 'active') {
      if (Device.isAndroid()) {
        if (this.timeout) BackgroundTimer.clearInterval(this.timeout);
      } else if (this.timeout) clearTimeout(this.timeout);
      this.timeout = undefined;

      if (this.paused) {
        const keyringController = (
          Engine.context as { KeyringController: KeyringController }
        ).KeyringController;
        await waitForKeychainUnlocked({ keyringController });
        // Add delay in case app opened from deeplink so that it doesn't create 2 connections.
        await wait(1000);
        this.reconnected = false;
        for (const id in this.connected) {
          this.resume({ channelId: id });
        }
      }
      this.paused = false;
    } else if (appState === 'background') {
      // Reset wentBack state
      wentBackMinimizer = true;
      // Cancel rpc queue anytime app is backgrounded
      this.rpcqueueManager.reset();
      if (!this.paused) {
        /**
         * Pause connections after 20 seconds of the app being in background to respect device resources.
         * Also, OS closes the app if after 30 seconds, the connections are still open.
         */
        if (Device.isIos()) {
          BackgroundTimer.start();
          this.timeout = setTimeout(() => {
            this.pause();
          }, TIMEOUT_PAUSE_CONNECTIONS) as unknown as number;
          BackgroundTimer.stop();
        } else if (Device.isAndroid()) {
          this.timeout = BackgroundTimer.setTimeout(() => {
            this.pause();
          }, TIMEOUT_PAUSE_CONNECTIONS);
          // TODO manage interval clearTimeout
        }
      }
    }
  }

  public async unmount() {
    Logger.log(`SDKConnect::unmount()`);
    try {
      AppState.removeEventListener('change', this._handleAppState.bind(this));
    } catch (err) {
      // Ignore if already removed
    }
    for (const id in this.connected) {
      this.connected[id].disconnect({ terminate: false });
    }

    if (Device.isAndroid()) {
      if (this.timeout) BackgroundTimer.clearInterval(this.timeout);
    } else if (this.timeout) clearTimeout(this.timeout);
    if (this.initTimeout) clearTimeout(this.initTimeout);
    this.timeout = undefined;
    this.initTimeout = undefined;
    this._initialized = false;
    this.approvedHosts = {};
    this.disabledHosts = {};
    this.connections = {};
    this.connected = {};
    this.connecting = {};
  }

  getSessionsStorage() {
    return this.connections;
  }

  public async init(props: {
    navigation: StackNavigationProp<{ [route: string]: { screen: string } }>;
  }) {
    if (this._initialized) {
      return;
    }

    // Change _initialized status at the beginning to prevent double initialization during dev.
    this._initialized = true;

    this.navigation = props.navigation;

    Logger.log(`SDKConnect::init()`);

    AppState.addEventListener('change', this._handleAppState.bind(this));

    const [connectionsStorage, hostsStorage] = await Promise.all([
      DefaultPreference.get(AppConstants.MM_SDK.SDK_CONNECTIONS),
      DefaultPreference.get(AppConstants.MM_SDK.SDK_APPROVEDHOSTS),
    ]);

    if (connectionsStorage) {
      this.connections = JSON.parse(connectionsStorage);
    }

    if (hostsStorage) {
      const uncheckedHosts = JSON.parse(hostsStorage) as ApprovedHosts;
      // Check if the approved hosts haven't timed out.
      const approvedHosts: ApprovedHosts = {};
      let expiredCounter = 0;
      for (const host in uncheckedHosts) {
        const expirationTime = uncheckedHosts[host];
        if (Date.now() < expirationTime) {
          // Host is valid, add it to the list.
          approvedHosts[host] = expirationTime;
        } else {
          expiredCounter += 1;
        }
      }
      if (expiredCounter > 1) {
        // Update the list of approved hosts excluding the expired ones.
        DefaultPreference.set(
          AppConstants.MM_SDK.SDK_APPROVEDHOSTS,
          JSON.stringify(approvedHosts),
        ).catch((err) => {
          throw err;
        });
      }
      this.approvedHosts = approvedHosts;
    }

    // Need to use a timeout to avoid race condition of double reconnection
    // - reconnecting from deeplink and reconnecting from being back in foreground.
    // We prioritize the deeplink and thus use the delay here.

    if (!this.paused) {
      const keyringController = (
        Engine.context as { KeyringController: KeyringController }
      ).KeyringController;
      await waitForKeychainUnlocked({ keyringController });
      await wait(2000);
      await this.reconnectAll();
    }
  }

  public static getInstance(): SDKConnect {
    if (!SDKConnect.instance) {
      SDKConnect.instance = new SDKConnect();
    }
    return SDKConnect.instance;
  }
}

export default SDKConnect;
