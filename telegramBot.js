import TelegramBot from 'tgfancy'
import config from './config.json'

export default new TelegramBot(
  process.env.TELEGRAM_TOKEN || config.TELEGRAM_TOKEN,
  {polling: true}
);