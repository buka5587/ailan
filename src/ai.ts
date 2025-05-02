// AI CORE

import * as fs from 'fs';
import { bindThis } from '@/decorators.js';
import loki from 'lokijs';
import got from 'got';
import { FormData, File } from 'formdata-node';
import chalk from 'chalk';
import { v4 as uuid } from 'uuid';

import config from '@/config.js';
import Module from '@/module.js';
import Message from '@/message.js';
import Friend, { FriendDoc } from '@/friend.js';
import type { User } from '@/misskey/user.js';
import Stream from '@/stream.js';
import log from '@/utils/log.js';
import { sleep } from './utils/sleep.js';
import pkg from '../package.json' with { type: 'json' };
import OpenAI from 'openai';

type MentionHook = (msg: Message) => Promise<boolean | HandlerResult>;
type ContextHook = (key: any, msg: Message, data?: any) => Promise<void | boolean | HandlerResult>;
type TimeoutCallback = (data?: any) => void;

export type HandlerResult = {
	reaction?: string | null;
	immediate?: boolean;
};

export type InstallerResult = {
	mentionHook?: MentionHook;
	contextHook?: ContextHook;
	timeoutCallback?: TimeoutCallback;
};

export type Meta = {
	lastWakingAt: number;
};

/**
 * 蓝
 */
export default class 蓝 {
	public readonly version = pkg._v;
	public account: User;
	public connection: Stream;
	public modules: Module[] = [];
	private mentionHooks: MentionHook[] = [];
	private contextHooks: { [moduleName: string]: ContextHook } = {};
	private timeoutCallbacks: { [moduleName: string]: TimeoutCallback } = {};
	public db: loki;
	public lastSleepedAt: number;

	private meta: loki.Collection<Meta>;

	private contexts: loki.Collection<{
		noteId?: string;
		userId?: string;
		module: string;
		key: string | null;
		data?: any;
	}>;

	private timers: loki.Collection<{
		id: string;
		module: string;
		insertedAt: number;
		delay: number;
		data?: any;
	}>;

	public friends: loki.Collection<FriendDoc>;
	public moduleData: loki.Collection<any>;

	/**
	 * 生成 AI 实例。
	 * @param account 用作 indigo 的帐户。
	 * @param modules 模块。leading module 具有更高的优先级。
	 */
	constructor(account: User, modules: Module[]) {
		this.account = account;
		this.modules = modules;

		let memoryDir = '.';
		if (config.memoryDir) {
			memoryDir = config.memoryDir;
		}
		const file = process.env.NODE_ENV === 'test' ? `${memoryDir}/test.memory.json` : `${memoryDir}/memory.json`;

		this.log(`Lodaing the memory from ${file}...`);

		this.db = new loki(file, {
			autoload: true,
			autosave: true,
			autosaveInterval: 1000,
			autoloadCallback: err => {
				if (err) {
					this.log(chalk.red(`Failed to load the memory: ${err}`));
				} else {
					this.log(chalk.green('The memory loaded successfully'));
					this.run();
				}
			}
		});
		this.openai = new OpenAI({
			apiKey: config.thirdPartyApiKey,
			baseURL: config.thirdPartyApiBaseUrl
		});
	}

	@bindThis
	public log(msg: string) {
		log(`[${chalk.magenta('AiOS')}]: ${msg}`);
	}

	@bindThis
	private run() {
		//#region Init DB
		this.meta = this.getCollection('meta', {});

		this.contexts = this.getCollection('contexts', {
			indices: ['key']
		});

		this.timers = this.getCollection('timers', {
			indices: ['module']
		});

		this.friends = this.getCollection('friends', {
			indices: ['userId']
		});

		this.moduleData = this.getCollection('moduleData', {
			indices: ['module']
		});
		//#endregion

		const meta = this.getMeta();
		this.lastSleepedAt = meta.lastWakingAt;

		// Init stream
		this.connection = new Stream();

		//#region Main stream
		const mainStream = this.connection.useSharedConnection('main');

		// 提及时
		mainStream.on('mention', async data => {
			if (data.userId == this.account.id) return; // 排除自己
			if (data.text && data.text.startsWith('@' + this.account.username)) {
				// Misskey的bug导致帖子被视为非公开
				if (data.text == null) data = await this.api('notes/show', { noteId: data.id });
				this.onReceiveMessage(new Message(this, data));
			}
		});

		// 被回复时
		mainStream.on('reply', async data => {
			if (data.userId == this.account.id) return; // 排除自己
			if (data.text && data.text.startsWith('@' + this.account.username)) return;
			// Misskey的bug导致帖子被视为非公开
			if (data.text == null) data = await this.api('notes/show', { noteId: data.id });
			this.onReceiveMessage(new Message(this, data));
		});

		// 被Renote时
		mainStream.on('renote', async data => {
			if (data.userId == this.account.id) return; // 排除自己
			if (data.text == null && (data.files || []).length == 0) return;

			// 添加反应
			this.api('notes/reactions/create', {
				noteId: data.id,
				reaction: 'love'
			});
		});

		// 消息
		mainStream.on('messagingMessage', data => {
			if (data.userId == this.account.id) return; // 排除自己
			this.onReceiveMessage(new Message(this, data));
		});

		// 通知
		mainStream.on('notification', data => {
			this.onNotification(data);
		});
		//#endregion

		// Install modules
		this.modules.forEach(m => {
			this.log(`Installing ${chalk.cyan.italic(m.name)}\tmodule...`);
			m.init(this);
			const res = m.install();
			if (res != null) {
				if (res.mentionHook) this.mentionHooks.push(res.mentionHook);
				if (res.contextHook) this.contextHooks[m.name] = res.contextHook;
				if (res.timeoutCallback) this.timeoutCallbacks[m.name] = res.timeoutCallback;
			}
		});

		// 定时器监控
		this.crawleTimer();
		setInterval(this.crawleTimer, 1000);

		setInterval(this.logWaking, 10000);

		this.log(chalk.green.bold('Ai am now running!'));
	}

	/**
	 * 当用户发起对话时
	 * (提及、回复、聊天消息)
	 */
	@bindThis
	private async onReceiveMessage(msg: Message): Promise<void> {
		this.log(chalk.gray(`<<< An message received: ${chalk.underline(msg.id)}`));

		// Ignore message if the user is a bot
		// To avoid infinity reply loop.
		if (msg.user.isBot) {
			return;
		}

		const isNoContext = msg.replyId == null;

		// Look up the context
		const context = isNoContext ? null : this.contexts.findOne({
			noteId: msg.replyId
		});

		let reaction: string | null = 'love';
		let immediate: boolean = false;

		//#region
		const invokeMentionHooks = async () => {
			let res: boolean | HandlerResult | null = null;

			for (const handler of this.mentionHooks) {
				res = await handler(msg);
				if (res === true || typeof res === 'object') break;
			}

			if (res != null && typeof res === 'object') {
				if (res.reaction != null) reaction = res.reaction;
				if (res.immediate != null) immediate = res.immediate;
			}
		};

		// 如果有上下文则调用上下文钩子
		// 否则调用各个模块的钩子直到匹配
		if (context != null) {
			const handler = this.contextHooks[context.module];
			const res = await handler(context.key, msg, context.data);

			if (res != null && typeof res === 'object') {
				if (res.reaction != null) reaction = res.reaction;
				if (res.immediate != null) immediate = res.immediate;
			}

			if (res === false) {
				await invokeMentionHooks();
			}
		} else {
			await invokeMentionHooks();
		}
		//#endregion

		if (!immediate) {
			await sleep(1000);
		}

		// 添加反应
		if (reaction) {
			this.api('notes/reactions/create', {
				noteId: msg.id,
				reaction: reaction
			});
		}
	}

	@bindThis
	private onNotification(notification: any) {
		switch (notification.type) {
			// 被添加反应时稍微提升亲密度
			// TODO: 妥善处理反应取消
			case 'reaction': {
				const friend = new Friend(this, { user: notification.user });
				friend.incLove(0.1);
				break;
			}

			default:
				break;
		}
	}

	@bindThis
	private crawleTimer() {
		const timers = this.timers.find();
		for (const timer of timers) {
			// 检查定时器是否到期
			if (Date.now() - (timer.insertedAt + timer.delay) >= 0) {
				this.log(`Timer expired: ${timer.module} ${timer.id}`);
				this.timers.remove(timer);
				this.timeoutCallbacks[timer.module](timer.data);
			}
		}
	}

	@bindThis
	private logWaking() {
		this.setMeta({
			lastWakingAt: Date.now(),
		});
	}

	/**
	 * 获取数据库的集合
	 */
	@bindThis
	public getCollection(name: string, opts?: any): loki.Collection {
		let collection: loki.Collection;

		collection = this.db.getCollection(name);

		if (collection == null) {
			collection = this.db.addCollection(name, opts);
		}

		return collection;
	}

	@bindThis
	public lookupFriend(userId: User['id']): Friend | null {
		const doc = this.friends.findOne({
			userId: userId
		});

		if (doc == null) return null;

		const friend = new Friend(this, { doc: doc });

		return friend;
	}

	/**
	 * 将文件上传到云端存储
	 */
	@bindThis
	public async upload(file: Buffer | fs.ReadStream, meta: { filename: string, contentType: string }) {
		const form = new FormData();
		form.set('i', config.i);
		form.set('file', new File([file], meta.filename, { type: meta.contentType }));

		const res = await got.post({
			url: `${config.apiUrl}/drive/files/create`,
			body: form
		}).json();
		return res;
	}

	/**
	 * 发布帖子
	 */
	@bindThis
	public async post(param: any) {
		const res = await this.api('notes/create', param);
		return res.createdNote;
	}

	/**
	 * 向指定用户发送聊天消息
	 */
	@bindThis
	public sendMessage(userId: any, param: any) {
		return this.post(Object.assign({
			visibility: 'specified',
			visibleUserIds: [userId],
		}, param));
	}

	/**
	 * 调用API
	 */
	@bindThis
	public api(endpoint: string, param?: any) {
		this.log(`API: ${endpoint}`);
		return got.post(`${config.apiUrl}/${endpoint}`, {
			json: Object.assign({
				i: config.i
			}, param)
		}).json();
	};

	/**
	 * 生成上下文，并等待用户的回复
	 * @param module 等待的模块名
	 * @param key 用于识别上下文的键
	 * @param id 如果是聊天消息上的上下文则为聊天对象的ID，否则为等待的帖子ID
	 * @param data 保存在上下文中的可选数据
	 */
	@bindThis
	public subscribeReply(module: Module, key: string | null, id: string, data?: any) {
		this.contexts.insertOne({
			noteId: id,
			module: module.name,
			key: key,
			data: data
		});
	}

	/**
	 * 取消等待回复
	 * @param module 取消的模块名
	 * @param key 用于识别上下文的键
	 */
	@bindThis
	public unsubscribeReply(module: Module, key: string | null) {
		this.contexts.findAndRemove({
			key: key,
			module: module.name
		});
	}

	/**
	 * 在指定的毫秒数后，调用该模块的超时回调。
	 * 此计时器会持久化到存储中，因此即使中途重启进程也仍然有效。
	 * @param module 模块名
	 * @param delay 毫秒数
	 * @param data 可选数据
	 */
	@bindThis
	public setTimeoutWithPersistence(module: Module, delay: number, data?: any) {
		const id = uuid();
		this.timers.insertOne({
			id: id,
			module: module.name,
			insertedAt: Date.now(),
			delay: delay,
			data: data
		});

		this.log(`Timer persisted: ${module.name} ${id} ${delay}ms`);
	}

	@bindThis
	public getMeta() {
		const rec = this.meta.findOne();

		if (rec) {
			return rec;
		} else {
			const initial: Meta = {
				lastWakingAt: Date.now(),
			};

			this.meta.insertOne(initial);
			return initial;
		}
	}

	@bindThis
	public setMeta(meta: Partial<Meta>) {
		const rec = this.getMeta();

		for (const [k, v] of Object.entries(meta)) {
			rec[k] = v;
		}

		this.meta.update(rec);
	}

	@bindThis
	private async processAIRequest(text: string): Promise<string> {
		try {
			const response = await this.openai.chat.completions.create({
				model: 'gpt-3.5-turbo',
				messages: [{
					role: 'system',
					content: '你是一个AI助手，请用友好、专业的语气回答问题'
				}, {
					role: 'user',
					content: text
				}],
				temperature: 0.7,
				max_tokens: 2000
			});
			return response.choices[0]?.message?.content || '没有收到有效回复';
		} catch (err) {
			this.log(chalk.red(`AI处理错误: ${err}`));
			return '抱歉，AI处理时出现错误，请稍后再试';
		}
	}
}
