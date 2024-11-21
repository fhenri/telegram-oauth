import { Bot, Context, session, SessionFlavor, webhookCallback } from 'grammy';
import { calendar_v3 } from '@googleapis/calendar';

interface SessionData {
	oauthToken?: string;
}
type MyContext = Context & SessionFlavor<SessionData>;

export interface Env {
	BOT_INFO: string;
	BOT_TOKEN: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	OAUTH_REDIRECT_URI: string;
	OAUTH_STATES: KVNamespace;
	OAUTH_TOKEN: KVNamespace;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const bot = new Bot<MyContext>(env.BOT_TOKEN, {
			botInfo: JSON.parse(env.BOT_INFO),
		});

		bot.command('hello', async (ctx) => {
			await ctx.reply('hello back');
		});

		bot.use(
			session({
				initial: (): SessionData => ({}),
			})
		);

		bot.command('login', async (ctx) => {
			const state = crypto.randomUUID();
			const chatId = ctx.chat.id.toString();

			// Store state in KV with 5 minute expiration
			await env.OAUTH_STATES.put(state, chatId, {
				expirationTtl: 300,
			});

			const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
			authUrl.searchParams.append('client_id', env.GOOGLE_CLIENT_ID);
			authUrl.searchParams.append('redirect_uri', env.OAUTH_REDIRECT_URI);
			authUrl.searchParams.append('response_type', 'code');
			authUrl.searchParams.append('scope', 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events');
			authUrl.searchParams.append('state', state);
			authUrl.searchParams.append('access_type', 'offline');

			await ctx.reply('Please authenticate with Google to use this bot:', {
				reply_markup: {
					inline_keyboard: [[{ text: 'Login with Google', url: authUrl.toString() }]],
				},
			});
		});

		if (request.url.includes('/api/auth/callback/google')) {
			console.log('getting google response');
			const url = new URL(request.url);
			const code = url.searchParams.get('code');
			const state = url.searchParams.get('state');

			if (!code || !state) {
				return new Response('Missing code or state', { status: 400 });
			}

			// Get chatId from KV
			const chatId = await env.OAUTH_STATES.get(state);
			if (!chatId) {
				return new Response('Invalid or expired chat', { status: 400 });
			}

			// Delete the state from KV as it's no longer needed
			await env.OAUTH_STATES.delete(state);

			// Exchange code for tokens
			const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					code,
					client_id: env.GOOGLE_CLIENT_ID,
					client_secret: env.GOOGLE_CLIENT_SECRET,
					redirect_uri: env.OAUTH_REDIRECT_URI,
					grant_type: 'authorization_code',
				}),
			});

			const tokenData = await tokenResponse.json();

			// Store the token in a token KV
			await env.OAUTH_TOKEN.put(chatId, JSON.stringify(tokenData));

			await bot.api.sendMessage(chatId, 'Successfully authenticated! You can now use the bot.');
			return new Response('Authentication successful! You can close this window.');
		}

		// Middleware to check authentication
		bot.use(async (ctx, next) => {
			if (!ctx.chat || !ctx.chat.id) {
				await ctx.reply('Please restart the chat');
				return;
			}

			const chatId = ctx.chat.id.toString();
			const token = await env.OAUTH_TOKEN.get(chatId);
			if (!token && ctx.message?.text !== '/login') {
				await ctx.reply('Please authenticate first using /login');
				return;
			}
			await next();
		});

		bot.command('calendar', async (ctx) => {
			await ctx.reply('Getting list of calendar');

			const chatId = ctx.chat.id.toString();
			const token = await env.OAUTH_TOKEN.get(chatId);
			const accessToken = token ? JSON.parse(token).access_token : null;

			try {
				const response = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
					headers: {
						Authorization: `Bearer ${accessToken}`,
						'Cache-Control': 'no-cache',
					},
				});

				if (response.status === 401) {
					await env.OAUTH_TOKEN.delete(chatId);
					await ctx.reply('Your session has expired. Please authenticate again using /login.');
					return;
				}

				const data = (await response.json()) as calendar_v3.Schema$CalendarList;

				// Format the calendar items into a table-like string
				let message = '📅 *Your Calendars*\n\n';

				if (data.items) {
					data.items.forEach((calendar, index) => {
						message += `*${index + 1}. ${calendar.summary}*\n`;
						if (calendar.description) {
							// Truncate description if too long
							const desc = calendar.description.length > 50 ? calendar.description.substring(0, 47) + '...' : calendar.description;
							message += `📝 ${desc}\n`;
						}
						message += `🌍 ${calendar.timeZone}\n\n`;
					});

					// Split message if it's too long for Telegram
					if (message.length > 4096) {
						const chunks = message.match(/.{1,4096}/g) || [];
						for (const chunk of chunks) {
							await ctx.reply(chunk, { parse_mode: 'Markdown' });
						}
					} else {
						await ctx.reply(message, { parse_mode: 'Markdown' });
					}
				}
			} catch (error) {
				await env.OAUTH_TOKEN.delete(chatId);
				await ctx.reply('Error fetching calendars. Please try authenticating again with /login');
			}
		});

		return webhookCallback(bot, 'cloudflare-mod')(request);
	},
};
