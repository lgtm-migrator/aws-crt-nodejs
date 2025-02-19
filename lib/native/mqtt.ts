/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0.
 */

/**
 *
 * A module containing support for mqtt connection establishment and operations.
 *
 * @packageDocumentation
 * @module mqtt
 * @mergeTarget
 */

import crt_native, { StringLike } from './binding';
import { NativeResource, NativeResourceMixin } from "./native_resource";
import { BufferedEventEmitter } from '../common/event';
import { CrtError } from './error';
import * as io from "./io";
import { HttpProxyOptions, HttpRequest } from './http';
export { HttpProxyOptions } from './http';
import {
    QoS,
    Payload,
    MqttRequest,
    MqttSubscribeRequest,
    MqttWill,
    OnMessageCallback,
    MqttConnectionConnected,
    MqttConnectionDisconnected,
    MqttConnectionResumed,
    DEFAULT_RECONNECT_MIN_SEC,
    DEFAULT_RECONNECT_MAX_SEC,
} from "../common/mqtt";
export { QoS, Payload, MqttRequest, MqttSubscribeRequest, MqttWill, OnMessageCallback } from "../common/mqtt";

/**
 * Listener signature for event emitted from an {@link MqttClientConnection} when an error occurs
 *
 * @param error the error that occurred
 *
 * @category MQTT
 */
export type MqttConnectionError = (error: CrtError) => void;

/**
 * Listener signature for event emitted from an {@link MqttClientConnection} when the connection has been
 * interrupted unexpectedly.
 *
 * @param error description of the error that occurred
 *
 * @category MQTT
 */
export type MqttConnectionInterrupted = (error: CrtError) => void;

/**
 * MQTT client
 *
 * @category MQTT
 */
export class MqttClient extends NativeResource {
    /**
     * @param bootstrap The {@link ClientBootstrap} to use for socket connections.  Leave undefined to use the
     *          default system-wide bootstrap (recommended).
     */
    constructor(readonly bootstrap: io.ClientBootstrap | undefined = undefined) {
        super(crt_native.mqtt_client_new(bootstrap != null ? bootstrap.native_handle() : null));
    }

    /**
     * Creates a new {@link MqttClientConnection}
     * @param config Configuration for the mqtt connection
     * @returns A new connection
     */
    new_connection(
        config: MqttConnectionConfig) {
        return new MqttClientConnection(this, config);
    }
}

/**
 * Configuration options for an MQTT connection
 *
 * @category MQTT
 */
export interface MqttConnectionConfig {
    /**
     * ID to place in CONNECT packet. Must be unique across all devices/clients.
     * If an ID is already in use, the other client will be disconnected.
     */
    client_id: string;

    /** Server name to connect to */
    host_name: string;

    /** Server port to connect to */
    port: number;

    /** Optional socket options */
    socket_options: io.SocketOptions;

    /** If true, connect to MQTT over websockets */
    use_websocket?: boolean;

    /**
     * Whether or not to start a clean session with each reconnect.
     * If True, the server will forget all subscriptions with each reconnect.
     * Set False to request that the server resume an existing session
     * or start a new session that may be resumed after a connection loss.
     * The `session_present` bool in the connection callback informs
     * whether an existing session was successfully resumed.
     * If an existing session is resumed, the server remembers previous subscriptions
     * and sends mesages (with QoS1 or higher) that were published while the client was offline.
     */
    clean_session?: boolean;

    /**
     * The keep alive value, in seconds, to send in CONNECT packet.
     * A PING will automatically be sent at this interval.
     * The server will assume the connection is lost if no PING is received after 1.5X this value.
     * This duration must be longer than {@link ping_timeout}.
     */
    keep_alive?: number;

    /**
     * Milliseconds to wait for ping response before client assumes
     * the connection is invalid and attempts to reconnect.
     * This duration must be shorter than keep_alive_secs.
     * Alternatively, TCP keep-alive via :attr:`SocketOptions.keep_alive`
     * may accomplish this in a more efficient (low-power) scenario,
     * but keep-alive options may not work the same way on every platform and OS version.
     */
    ping_timeout?: number;

    /**
     * Milliseconds to wait for the response to the operation requires response by protocol.
     * Set to zero to disable timeout. Otherwise, the operation will fail if no response is
     * received within this amount of time after the packet is written to the socket.
     * It applied to PUBLISH (QoS>0) and UNSUBSCRIBE now.
     */
    protocol_operation_timeout?: number;

    /**
     * Minimum seconds to wait between reconnect attempts.
     * Must be <= {@link reconnect_max_sec}.
     * Wait starts at min and doubles with each attempt until max is reached.
     */
    reconnect_min_sec?: number;

    /**
     * Maximum seconds to wait between reconnect attempts.
     * Must be >= {@link reconnect_min_sec}.
     * Wait starts at min and doubles with each attempt until max is reached.
     */
    reconnect_max_sec?: number;

    /**
     * Will to send with CONNECT packet. The will is
     * published by the server when its connection to the client is unexpectedly lost.
     */
    will?: MqttWill;

    /** Username to connect with */
    username?: string;

    /** Password to connect with */
    password?: string;

    /**
     * TLS context for secure socket connections.
     * If None is provided, then an unencrypted connection is used.
     */
    tls_ctx?: io.ClientTlsContext;

    /** Optional proxy options */
    proxy_options?: HttpProxyOptions;

    /**
     * Optional function to transform websocket handshake request.
     * If provided, function is called each time a websocket connection is attempted.
     * The function may modify the HTTP request before it is sent to the server.
     */
    websocket_handshake_transform?: (request: HttpRequest, done: (error_code?: number) => void) => void;
}

/** @internal */
function normalize_payload(payload: Payload): StringLike {
    if (ArrayBuffer.isView(payload)) {
        // native can use ArrayBufferView bytes directly
        return payload as ArrayBufferView;
    }
    if (payload instanceof ArrayBuffer) {
        // native can use ArrayBuffer bytes directly
        return payload;
    }
    if (typeof payload === 'string') {
        // native will convert string to utf-8
        return payload;
    }
    if (typeof payload === 'object') {
        // convert object to JSON string (which will be converted to utf-8 in native)
        return JSON.stringify(payload);
    }

    throw new TypeError("payload parameter must be a string, object, or DataView.");
}

/**
 * MQTT client connection
 *
 * @category MQTT
 */
export class MqttClientConnection extends NativeResourceMixin(BufferedEventEmitter) {
    readonly tls_ctx?: io.ClientTlsContext; // this reference keeps the tls_ctx alive beyond the life of the connection

    /**
     * @param client The client that owns this connection
     * @param config The configuration for this connection
     */
    constructor(readonly client: MqttClient, private config: MqttConnectionConfig) {
        super();
        // If there is a will, ensure that its payload is normalized to a DataView
        const will = config.will ?
            {
                topic: config.will.topic,
                qos: config.will.qos,
                payload: normalize_payload(config.will.payload),
                retain: config.will.retain
            }
            : undefined;

        /** clamp reconnection time out values */
        var min_sec = DEFAULT_RECONNECT_MIN_SEC;
        var max_sec = DEFAULT_RECONNECT_MAX_SEC;
        if (config.reconnect_min_sec !== undefined) {
            min_sec = config.reconnect_min_sec;
            // clamp max, in case they only passed in min
            max_sec = Math.max(min_sec, max_sec);
        }

        if (config.reconnect_max_sec !== undefined) {
            max_sec = config.reconnect_max_sec;
            // clamp min, in case they only passed in max (or passed in min > max)
            min_sec = Math.min(min_sec, max_sec);
        }

        this._super(crt_native.mqtt_client_connection_new(
            client.native_handle(),
            (error_code: number) => { this._on_connection_interrupted(error_code); },
            (return_code: number, session_present: boolean) => { this._on_connection_resumed(return_code, session_present); },
            config.tls_ctx ? config.tls_ctx.native_handle() : null,
            will,
            config.username,
            config.password,
            config.use_websocket,
            config.proxy_options ? config.proxy_options.create_native_handle() : undefined,
            config.websocket_handshake_transform,
            min_sec,
            max_sec,
        ));
        this.tls_ctx = config.tls_ctx;
        crt_native.mqtt_client_connection_on_message(this.native_handle(), this._on_any_publish.bind(this));

        /*
         * Failed mqtt operations (which is normal) emit error events as well as rejecting the original promise.
         * By installing a default error handler here we help prevent common issues where operation failures bring
         * the whole program to an end because a handler wasn't installed.  Programs that install their own handler
         * will be unaffected.
         */
        this.on('error', (error) => {});
    }

    private close() {
        crt_native.mqtt_client_connection_close(this.native_handle());
    }

    /**
     * Emitted when the connection successfully establishes itself for the first time
     *
     * @event
     */
    static CONNECT = 'connect';

    /**
     * Emitted when connection has disconnected sucessfully.
     *
     * @event
     */
    static DISCONNECT = 'disconnect';

    /**
     * Emitted when an error occurs.  The error will contain the error
     * code and message.
     *
     * @event
     */
    static ERROR = 'error';

    /**
     * Emitted when the connection is dropped unexpectedly. The error will contain the error
     * code and message.  The underlying mqtt implementation will attempt to reconnect.
     *
     * @event
     */
    static INTERRUPT = 'interrupt';

    /**
     * Emitted when the connection reconnects (after an interrupt). Only triggers on connections after the initial one.
     *
     * @event
     */
    static RESUME = 'resume';

    /**
     * Emitted when any MQTT publish message arrives.
     *
     * @event
     */
    static MESSAGE = 'message';

    on(event: 'connect', listener: MqttConnectionConnected): this;

    on(event: 'disconnect', listener: MqttConnectionDisconnected): this;

    on(event: 'error', listener: MqttConnectionError): this;

    on(event: 'interrupt', listener: MqttConnectionInterrupted): this;

    on(event: 'resume', listener: MqttConnectionResumed): this;

    on(event: 'message', listener: OnMessageCallback): this;

    // Overridden to allow uncorking on ready
    on(event: string | symbol, listener: (...args: any[]) => void): this {
        super.on(event, listener);
        if (event == 'connect') {
            process.nextTick(() => {
                this.uncork();
            })
        }
        return this;
    }

    /**
     * Open the actual connection to the server (async).
     * @returns A Promise which completes whether the connection succeeds or fails.
     *          If connection fails, the Promise will reject with an exception.
     *          If connection succeeds, the Promise will return a boolean that is
     *          true for resuming an existing session, or false if the session is new
     */
    async connect() {
        return new Promise<boolean>((resolve, reject) => {
            reject = this._reject(reject);

            try {
                crt_native.mqtt_client_connection_connect(
                    this.native_handle(),
                    this.config.client_id,
                    this.config.host_name,
                    this.config.port,
                    this.config.socket_options.native_handle(),
                    this.config.keep_alive,
                    this.config.ping_timeout,
                    this.config.protocol_operation_timeout,
                    this.config.clean_session,
                    this._on_connect_callback.bind(this, resolve, reject),
                );
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * The connection will automatically reconnect. To cease reconnection attempts, call {@link disconnect}.
     * To resume the connection, call {@link connect}.
     * @deprecated
     */
    async reconnect() {
        return new Promise<boolean>((resolve, reject) => {
            reject = this._reject(reject);

            try {
                crt_native.mqtt_client_connection_reconnect(this.native_handle(), this._on_connect_callback.bind(this, resolve, reject));
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Publish message (async).
     * If the device is offline, the PUBLISH packet will be sent once the connection resumes.
     *
     * @param topic Topic name
     * @param payload Contents of message
     * @param qos Quality of Service for delivering this message
     * @param retain If true, the server will store the message and its QoS so that it can be
     *               delivered to future subscribers whose subscriptions match the topic name
     * @returns Promise which returns a {@link MqttRequest} which will contain the packet id of
     *          the PUBLISH packet.
     *
     * * For QoS 0, completes as soon as the packet is sent.
     * * For QoS 1, completes when PUBACK is received.
     * * For QoS 2, completes when PUBCOMP is received.
     */
    async publish(topic: string, payload: Payload, qos: QoS, retain: boolean = false) {
        return new Promise<MqttRequest>((resolve, reject) => {
            reject = this._reject(reject);
            try {
                crt_native.mqtt_client_connection_publish(this.native_handle(), topic, normalize_payload(payload), qos, retain, this._on_puback_callback.bind(this, resolve, reject));
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Subscribe to a topic filter (async).
     * The client sends a SUBSCRIBE packet and the server responds with a SUBACK.
     *
     * subscribe() may be called while the device is offline, though the async
     * operation cannot complete successfully until the connection resumes.
     *
     * Once subscribed, `callback` is invoked each time a message matching
     * the `topic` is received. It is possible for such messages to arrive before
     * the SUBACK is received.
     *
     * @param topic Subscribe to this topic filter, which may include wildcards
     * @param qos Maximum requested QoS that server may use when sending messages to the client.
     *            The server may grant a lower QoS in the SUBACK
     * @param on_message Optional callback invoked when message received.
     * @returns Promise which returns a {@link MqttSubscribeRequest} which will contain the
     *          result of the SUBSCRIBE. The Promise resolves when a SUBACK is returned
     *          from the server or is rejected when an exception occurs.
     */
    async subscribe(topic: string, qos: QoS, on_message?: OnMessageCallback) {
        return new Promise<MqttSubscribeRequest>((resolve, reject) => {
            reject = this._reject(reject);

            try {
                crt_native.mqtt_client_connection_subscribe(this.native_handle(), topic, qos, on_message, this._on_suback_callback.bind(this, resolve, reject));
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Unsubscribe from a topic filter (async).
     * The client sends an UNSUBSCRIBE packet, and the server responds with an UNSUBACK.
     * @param topic The topic filter to unsubscribe from. May contain wildcards.
     * @returns Promise wihch returns a {@link MqttRequest} which will contain the packet id
     *          of the UNSUBSCRIBE packet being acknowledged. Promise is resolved when an
     *          UNSUBACK is received from the server or is rejected when an exception occurs.
     */
    async unsubscribe(topic: string) {
        return new Promise<MqttRequest>((resolve, reject) => {
            reject = this._reject(reject);

            try {
                crt_native.mqtt_client_connection_unsubscribe(this.native_handle(), topic, this._on_unsuback_callback.bind(this, resolve, reject));
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Close the connection (async).
     * @returns Promise which completes when the connection is closed.
    */
    async disconnect() {
        return new Promise<void>((resolve, reject) => {
            reject = this._reject(reject);

            try {
                crt_native.mqtt_client_connection_disconnect(
                    this.native_handle(),
                    this._on_disconnect_callback.bind(this, resolve)
                );
            } catch (e) {
                reject(e);
            }
        });
    }

    // Wrap a promise rejection with a function that will also emit the error as an event
    private _reject(reject: (reason: any) => void) {
        return (reason: any) => {
            reject(reason);

            process.nextTick(() => {
                this.emit('error', new CrtError(reason));
            });
        };
    }

    private _on_connection_interrupted(error_code: number) {
        this.emit('interrupt', new CrtError(error_code));
    }

    private _on_connection_resumed(return_code: number, session_present: boolean) {
        this.emit('resume', return_code, session_present);
    }

    private _on_any_publish(topic: string, payload: ArrayBuffer, dup: boolean, qos: QoS, retain: boolean) {
        this.emit('message', topic, payload, dup, qos, retain);
    }

    private _on_connect_callback(resolve : (value: (boolean | PromiseLike<boolean>)) => void, reject : (reason?: any) => void, error_code: number, return_code: number, session_present: boolean) {
        if (error_code == 0 && return_code == 0) {
            resolve(session_present);
            this.emit('connect', session_present);
        } else if (error_code != 0) {
            reject("Failed to connect: " + io.error_code_to_string(error_code));
        } else {
            reject("Server rejected connection.");
        }
    }

    private _on_puback_callback(resolve : (value: (MqttRequest | PromiseLike<MqttRequest>)) => void, reject : (reason?: any) => void, packet_id: number, error_code: number) {
        if (error_code == 0) {
            resolve({ packet_id });
        } else {
            reject("Failed to publish: " + io.error_code_to_string(error_code));
        }
    }

    private _on_suback_callback(resolve : (value: (MqttSubscribeRequest | PromiseLike<MqttSubscribeRequest>)) => void, reject : (reason?: any) => void, packet_id: number, topic: string, qos: QoS, error_code: number) {
        if (error_code == 0) {
            resolve({ packet_id, topic, qos, error_code });
        } else {
            reject("Failed to subscribe: " + io.error_code_to_string(error_code));
        }
    }

    private _on_unsuback_callback(resolve : (value: (MqttRequest | PromiseLike<MqttRequest>)) => void, reject : (reason?: any) => void, packet_id: number, error_code: number) {
        if (error_code == 0) {
            resolve({ packet_id });
        } else {
            reject("Failed to unsubscribe: " + io.error_code_to_string(error_code));
        }
    }

    private _on_disconnect_callback(resolve: (value?: (void | PromiseLike<void>)) => void) {
        resolve();
        this.emit('disconnect');
        this.close();
    }
}
