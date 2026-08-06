export type IpcChannelKind = 'invoke' | 'event' | 'push';

export type IpcDomain =
  | 'account'
  | 'ai'
  | 'browser'
  | 'extensions'
  | 'license'
  | 'network'
  | 'ui'
  | 'updates';

export interface IpcChannelContract {
  readonly channel: string;
  readonly kind: IpcChannelKind;
  readonly domain: IpcDomain;
  readonly registrar: string;
  readonly requestSchema?: string;
}

export interface IpcErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
}

export type IpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: IpcErrorPayload };
