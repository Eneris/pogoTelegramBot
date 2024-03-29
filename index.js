import Pokemons from './static/pokemon.json'
import Moves from './static/moves.json'
import moment from 'moment'
import TelegramBot from './telegramBot'
import config from './config.json'
import fb from './firebase'
import {fromJS} from 'immutable'

const DEBUG = process.env.DEBUG || config.DEBUG
const MAPS_API_KEY = process.env.MAPS_API_KEY || config.MAPS_API_KEY

let initialLoadCompleted = false
let notificationsEnabled = false

let chats = fromJS({})
let serviceUserId = null
let serviceChat = null

const onlineRef = fb.ref('/config/bot/status')
const chatsRef = fb.ref('/config/bot/chats')
const chatsRefFiltered = fb.ref('/config/bot/chats').orderByChild('enabled').equalTo(true)
const enabledRef = fb.ref('/config/bot/enabled')
const pokemonsRef = fb.ref('/data/pokemons').orderByChild('last_modified').startAt((new Date()).valueOf())
const serviceChatRef = fb.ref('/config/bot/serviceUserId')
const serviceUserRef = fb.ref('/config/bot/serviceUserId')

const banGifUrl = 'https://media.giphy.com/media/H99r2HtnYs492/giphy.gif'
const warningGifUrl = 'https://media.giphy.com/media/lqczWksNBr4HK/giphy.gif'
const nopeGifUrl = 'https://media.giphy.com/media/149t2dI5M5nzvq/giphy.gif'

onlineRef.set('starting')
onlineRef.onDisconnect().set('offline')

chatsRefFiltered.once('value', snap => {
  chats = fromJS(snap.val() || {}).map(item => item.toJS())
  initialLoadCompleted = true
  onlineRef.set('online')
  console.log('Initial load complete...', chats.size, 'chats found')
})

serviceUserRef.on('value', serviceUserIdSnap => serviceUserId = serviceUserIdSnap.val())
serviceChatRef.on('value', serviceChatSnap => serviceChat = serviceChatSnap.val())

chatsRefFiltered.on('child_added', chatsSnap => handleChatChange(chatsSnap.key, chatsSnap.val()))
chatsRefFiltered.on('child_changed', chatsSnap => handleChatChange(chatsSnap.key, chatsSnap.val()))
chatsRefFiltered.on('child_removed', chatsSnap => handleChatChange(chatsSnap.key))

const handleChatChange = (key, snap) => {
  if (snap) {
    console.log("Chat added/changed", key)
    chats = chats.set(key, snap)
  } else {
    console.log("Chat removed", key)
    chats = chats.remove(key)
  }
}

enabledRef.on('value', botEnabledSnap => {
  const enabled = DEBUG ? false : botEnabledSnap.val()
  console.log('Notifications ' + (enabled ? 'enabled' : 'disabled'))
  notificationsEnabled = enabled
})

let lastPokemonAdded = new Date()


pokemonsRef.on('child_added', pokemonSnap => {
  if (!initialLoadCompleted && true) return

  lastPokemonAdded = new Date()

  const props = pokemonSnap.val()
  const key = pokemonSnap.key
  sendNewPokemon(key, props)

})

setInterval(() => {
  const currentTime = new Date()
  const deltaTime = currentTime.valueOf() - lastPokemonAdded.valueOf()
  console.log('[' + (new Date()).toLocaleString() + '] Last feed ' + deltaTime / 1000 / 60 + ' minutes ago')
  if (deltaTime > 30 * 60 * 1000) {

    TelegramBot.sendMessage(serviceChat, "WARNING!: Data feed may be broken! Bot hasn't got any data for longer than 30 minutes. Last " + lastPokemonAdded.toLocaleTimeString())
  }
}, 10 * 60 * 1000)


TelegramBot.onText(/\/watch( .+){1,2}/, (msg, match) => handleWatchCommand(msg, match))
TelegramBot.onText(/\/unwatch (.+)/, (msg, match) => handleUnwatchCommand(msg, match))
TelegramBot.onText(/\/start/, (msg/*, match*/) => handleStartCommand(msg/*, match*/))
TelegramBot.onText(/\/stop/, (msg/*, match*/) => handleStopCommand(msg/*, match*/))
TelegramBot.onText(/\/list/, (msg/*, match*/) => handleListCommand(msg/*, match*/))
TelegramBot.onText(/\/enable/, (msg/*, match*/) => handleEnableCommand(msg, true))
TelegramBot.onText(/\/disable/, (msg/*, match*/) => handleEnableCommand(msg, false))
TelegramBot.onText(/\/location/, (msg/*, match*/) => handleSetLocationCommand(msg/*, match*/))
TelegramBot.onText(/\/distance/, (msg, match) => handleSetLocationDistanceCommand(msg, match, true))
TelegramBot.onText(/\/distance (.+)/, (msg, match) => handleSetLocationDistanceCommand(msg, match))
TelegramBot.onText(/\/sendtoall (.+)/, (msg, match) => handleServiceSendToAllCommand(msg, match))
TelegramBot.onText(/\/ban (.+)/, (msg, match) => handleBanCommand(msg, match))
TelegramBot.onText(/\/warning (.+)/, (msg, match) => handleWarningCommand(msg, match))
TelegramBot.onText(/\/chatid (.+)/, (msg, match) => handleGetChatIdCommand(msg, match))
// TelegramBot.onText(/\/trololo (.+)/, (msg, match) => handleTrololoCommand(msg, match))
TelegramBot.on('inline_query', (msg/*, match*/) => handleInlineQuery(msg/*, match*/))
TelegramBot.on('location', (msg/*, match*/) => handleSetLocationCommand(msg/*, match*/))


function getDistance(lat1, lon1, lat2, lon2) {
  let R = 6371;
  let dLat = (lat2 - lat1) * Math.PI / 180;
  let dLon = (lon2 - lon1) * Math.PI / 180;
  let a =
    0.5 - Math.cos(dLat) / 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    (1 - Math.cos(dLon)) / 2;

  return R * 2 * Math.asin(Math.sqrt(a))
}

function isExistingPokemon(input) {
  try {
    if (!(input > 0 && input < 700)) return false
    if (!Pokemons[input]) return false
  } catch (err) {
    return false
  }

  let pokemon = Pokemons[input]
  pokemon.id = input
  return pokemon
}

function checkExistingPokemon(pokemonId) {
  const pokemon = isExistingPokemon(pokemonId)
  if (!pokemon) {
    TelegramBot.sendMessage(chatId, `Pokemon with ID ${pokemonId} doesnt exist!`, {"disable_notification": true})
    return false
  }

  return pokemon
}

function checkAccessRights(msg, onSuccess, onFailed) {
  const chatId = msg.chat.id
  const userId = msg.from.id

  const chat = chats.get(chatId + '')

  if (msg.from.id === serviceUserId) return onSuccess()

  if (chat && chat.banned) {
    console.log('Got request from banned user', userId, 'in chat', chatId)
    return TelegramBot.sendVideo(chatId, nopeGifUrl)
  }

  TelegramBot.getChat(chatId).then(chatProps => {
    if (chatProps.type === 'private') {
      onSuccess()
    } else {
      TelegramBot.getChatAdministrators(chatId).then(chatAdminsProps => {
        chatAdminsProps.filter(item => item.user.id === userId).length ? onSuccess() : onFailed()
      })
    }
  })
}

function handleFailedChat(chatId, err) {
  if (err.error_code === 400 && err.parameters && err.parameters.migrate_to_chat_id) {
    const chat = chats.get(chatId)
    if (chat) {
      const updates = []
      updates[err.parameters.migrate_to_chat_id] = props
      updates[chatId] = null
      chatsRef.update(updates)
    }
  } else if (serviceUserId) {
    TelegramBot.sendMessage(serviceUserId, `Failed chat message: \n${err.error_code}: ${err.description}`)
    chatsRef.child(chatId).update({
      enabled: false,
      status: err.description || ''
    })
  }
}

function sendAccessDenied(chatId, replyToId) {
  TelegramBot.sendMessage(chatId, 'You need to be admin of this chat to do that!', {
    "reply_to_message_id": replyToId,
    "disable_notification": true
  })
}


function sendNewPokemon(encounterId, props) {
  const disappearTime = new Date(props.disappear_time)
  const disappearIn = new Date(props.disappear_time - (new Date()).getTime())
  const shortDissappearTime = `${disappearIn.getMinutes()}min ${disappearIn.getSeconds()}s`
  const longDissappearTime = `${('0' + disappearTime.getHours()).substr(-2)}:${('0' + disappearTime.getMinutes()).substr(-2)}:${('0' + disappearTime.getSeconds()).substr(-2)}`
  let attack = props.individual_attack
  let defense = props.individual_defense
  let stamina = props.individual_stamina
  let iv = (attack >= 0 && defense >= 0 && stamina >= 0) ? Math.round((attack + defense + stamina) * 100 / 45) : undefined
  const move1 = props.move_1 ? Moves[props.move_1] : null
  const move2 = props.move_2 ? Moves[props.move_2] : null
  const zoom = 15
  const sideLength = 400
  const markerColor = 'red'
  const location = props.latitude + ',' + props.longitude
  const message =
    `<b>${props.pokemon_name}</b> - \#${props.pokemon_id}\n` +
    `<b>Disappears</b>: ${longDissappearTime} (${shortDissappearTime})\n` +
    (iv >= 0 ? `<b>IV</b>: ${iv}\n` : '') +
    (move1 && move1 !== null ? `<b>Move 1</b>: ${move1.name} (${move1.type})\n` : '') +
    (move2 && move2 !== null ? `<b>Move 2</b>: ${move2.name} (${move2.type})\n` : '') +
    `<a href="https://maps.googleapis.com/maps/api/staticmap?center=${location}&zoom=${zoom}&size=${sideLength}x${sideLength}&markers=color:${markerColor}|${location}&key=${MAPS_API_KEY}">&#8205;</a>` +
    `<b>Maps</b>: <a href="http://maps.google.com/maps?q=${location}">Google</a> | <a href="http://maps.apple.com/?q=${location}">iOS</a> | <a href="http://waze.to/?ll=${location}">Waze</a>\n`

  chats.filter(chat => !chat.banned).map((chat, chatId) => {
    const minIv = chat.watchedPokemons && chat.watchedPokemons[props.pokemon_id]
    if (minIv === undefined || minIv === null) return
    if (iv === undefined && minIv > 0) return
    if (iv >= 0 && iv < minIv) return

    const latitude = chat.filterLocation && chat.filterLocation.latitude || 49.195156
    const longitude = chat.filterLocation && chat.filterLocation.longitude || 16.608267
    const distance = chat.filterLocation && chat.filterLocation.distance || 3

    if (getDistance(props.latitude, props.longitude, latitude, longitude) > distance) return

    if (notificationsEnabled) {
      console.log(`[ ${new Date().toLocaleString()} ] Send pokemon ${encounterId} ${props.pokemon_name} IV ${iv >= 0 ? iv : '??'}% - #${props.pokemon_id} notification to ${chatId}`)
      return TelegramBot.sendMessage(
        chatId,
        message,
        {
          parse_mode: "html",
          disable_web_page_preview: false,
          disable_notification: false
        })
    }
  })
}


function handleWatchCommand(msg, match) {
  const chatId = msg.chat.id.toString()

  const params = match[1].trim().split(' ').map(item => parseInt(item))


  checkAccessRights(msg, () => {
    const pokemon = isExistingPokemon(params[0])
    const minIv = params[1] || 0
    if (!pokemon) {
      TelegramBot.sendMessage(chatId, 'There is no such pokemon!', {
        "reply_to_message_id": msg.message_id,
        "disable_notification": true
      })
      return false
    }


    const chat = chats.get(chatId)
    if (!chat) {
      TelegramBot.sendMessage(chatId, 'Bot is not started here. Please send /start', {
        "reply_to_message_id": msg.message_id,
        "disable_notification": true
      })
      return
    }


    const savedMinIv = chat.watchedPokemons && chat.watchedPokemons[pokemon.id]
    console.log('got watch', savedMinIv)
    if (savedMinIv === undefined || savedMinIv === null || !(savedMinIv >= 0)) {
      TelegramBot.sendMessage(chatId, `${pokemon.name} added to watch list`, {
        "reply_to_message_id": msg.message_id,
        "disable_notification": true
      })
    } else if (minIv !== savedMinIv) {
      TelegramBot.sendMessage(chatId, `${pokemon.name} minimum IV updated to ${minIv}%`, {
        "reply_to_message_id": msg.message_id,
        "disable_notification": true
      })
    }

    console.log(`Add notify for ${pokemon.name}(${pokemon.id}) IV: ${minIv} to chat ${chatId}`)
    chatsRef.child(chatId).child('watchedPokemons').child(pokemon.id).set(minIv)
    chatsRef.child(chatId).child('enabled').set(true)

  }, () => sendAccessDenied(chatId, msg.message_id))
}

function handleUnwatchCommand(msg, match) {
  const chatId = msg.chat.id
  const pokemon = checkExistingPokemon(match[1])

  if (!pokemon || !chatId) return

  checkAccessRights(msg, () => {
    console.log(`Remove notify for ${pokemon.name}(${pokemon.id}) for chat ${chatId}`)
    chatsRef.child(chatId).child('watchedPokemons').child(pokemon.id).set(null)
    TelegramBot.sendMessage(chatId, `${pokemon.name} removed from watch list`, {
      "reply_to_message_id": msg.message_id,
      "disable_notification": true
    })
  }, () => sendAccessDenied(chatId, msg.message_id))
}

function handleStartCommand(msg) {
  const chatId = msg.chat.id.toString()

  checkAccessRights(msg, () => {
    const startInvoker = msg.from.id
    const chat = chats.has(chatId) && chats.get(chatId)
    console.log(`Starting new chat ${chatId}`)
    if (!chat || !chat.enabled) {
      TelegramBot.getChat(chatId).then(chatProps => {
        chatProps.startInvoker = startInvoker
        chatProps.enabled = true
        chatsRef.child(chatId).set(chatProps)
      })
      TelegramBot.sendMessage(chatId, `
        Hello... Please see other commands under "/" button
      `, {"reply_to_message_id": msg.message_id, "disable_notification": true})
    } else {
      TelegramBot.sendMessage(chatId, 'Bot is already running if you want to stop it, type /stop', {
        "reply_to_message_id": msg.message_id,
        "disable_notification": true
      })
    }
  }, () => sendAccessDenied(chatId, msg.message_id))
}

function handleStopCommand(msg) {
  const chatId = msg.chat.id.toString()

  checkAccessRights(msg, () => {
    TelegramBot.getChat(chatId).then(chatProps => {
      console.log(`Stopping chat ${chatId}`)
      if (chatProps.type === 'private') {
        TelegramBot.sendMessage(chatId, 'Bot was disabled but i cannot leave private chats sorry...', {
          "reply_to_message_id": msg.message_id,
          "disable_notification": true
        })
      } else {
        TelegramBot.sendMessage(chatId, 'I am out... bye', {
          "reply_to_message_id": msg.message_id,
          "disable_notification": true
        })
          .then(() => TelegramBot.leaveChat(chatId))
      }
    })

    let updates = {}
    updates[`${chatId}/enabled`] = false
    updates[`${chatId}/status`] = "Used /stop command"
    chatsRef.update(updates)
  }, () => sendAccessDenied(chatId, msg.message_id))
}

function handleListCommand(msg) {
  const chatId = msg.chat.id.toString()
  console.log("Got list command for", chatId)
  if (chats.has(chatId)) {
    checkAccessRights(msg, () => {
      const chat = chats.get(chatId)
      const watchedPokemons = chat.watchedPokemons && Object.keys(chat.watchedPokemons).map(pokemonId => {
          const pokemon = Pokemons[pokemonId]
          if (!pokemon) return ''
          return `#${pokemonId} - ${pokemon.name} - ${chat.watchedPokemons[pokemonId]}%`
        }).join('\n')
      if (watchedPokemons) {
        TelegramBot.sendMessage(chatId, `Here is list of watched pokemons:\n ${watchedPokemons}`, {
          "reply_to_message_id": msg.message_id,
          "disable_notification": true
        })
      } else {
        TelegramBot.sendMessage(chatId, 'List is empty... add some by "/watch ID" command', {
          "reply_to_message_id": msg.message_id,
          "disable_notification": true
        })
      }
    })
  }
}

function handleSetLocationCommand(msg, match) {
  const chatId = msg.chat.id.toString()
  const chat = chats.get(chatId)
  let location = msg.location || null

  checkAccessRights(msg, () => {
    if (!location) {
      if (chat.filterLocation && chat.filterLocation.latitude && chat.filterLocation.longitude) {
        return TelegramBot.sendVenue(chatId, chat.filterLocation.latitude, chat.filterLocation.longitude, "Here is your current settings", "If you want to change it, just send me new location")
      }

      if (!match)
        return TelegramBot.sendMessage(chatId, "Ok send me location...", {
          "reply_to_message_id": msg.message_id,
          "disable_notification": true
        })

      if (match[1].match(/[0-9]{1,3}\.[0-9]*\,\ *[0-9]{1,3}\.[0-9]*/)) {
        let pom = match[1].split(',')
        location = {
          latitude: parseFloat(pom[0]),
          longitude: parseFloat(pom[1])
        }
      }
    }

    console.log(`Got set location command for ${chatId} at ${location}`)

    location.distance = (chat.filterLocation && chat.filterLocation.distance) || 1
    chatsRef.child(chatId).child('filterLocation').set(location)
    TelegramBot.sendMessage(chatId, "Location saved", {
      "reply_to_message_id": msg.message_id,
      "disable_notification": true
    })
  }, () => sendAccessDenied(chatId, msg.message_id))
}

function handleSetLocationDistanceCommand(msg, match, isGetter) {
  checkAccessRights(msg, () => {
    const chatId = msg.chat.id.toString()
    const chat = chats.get(chatId)

    if (isGetter) {
      return TelegramBot.sendMessage(chatId, `Your current filter distance is ${chat.filterLocation && chat.filterLocation.distance || 3}km`)
    } else {
      const distance = Math.min(parseFloat(match[1]), 20)
      console.log(`Got set distance command for ${chatId} to ${distance}km`)
      if (!distance || distance < 0)
        return TelegramBot.sendMessage(chatId, "Sorry but this is not valid input")

      chatsRef.child(chatId).child('filterLocation').child('distance').set(distance)
      TelegramBot.sendMessage(chatId, `Filter distance changed to ${distance}km`, {
        "reply_to_message_id": msg.message_id,
        "disable_notification": true
      })
    }
  }, () => sendAccessDenied(chatId, msg.message_id))
}

function handleEnableCommand(msg, enable) {
  const chatId = msg.chat.id
  checkAccessRights(msg, () => {
    chatsRef.child(chatId).child('enabled').set(enable)

    const replyText = enable ?
      `Alerts enabled... send /disable to turn them off`
      :
      `Alerts disabled... send /enable to turn them back on`

    console.log(`Got ${enable ? 'enable' : 'disable'} command for ${chatId}`)

    TelegramBot.sendMessage(chatId, replyText, {
      "reply_to_message_id": msg.message_id,
      "disable_notification": true
    })
  }, () => sendAccessDenied(chatId, msg.message_id))
}

function handleGetChatIdCommand(msg, match) {
  const chatId = msg.chat.id
  if (chatId == serviceUserId) {
    const chatFound = chats.find(chat => chat.username && chat.username.match(match[1]))
    if (chatFound) {
      TelegramBot.sendMessage(chatId, `${match[1]} is ${chatFound.id}`)
    }
  }
}
//
// function handleTrololoCommand(msg, match) {
//   if (msg.from.id !== serviceUserId) return
//
//   const data = match[1].split(' ')
//   const movesKeys = Object.keys(Moves)
//   const chatId = data[0]
//   const latitude = data[1]
//   const longitude = data[2]
//
//   const chat = chats.get(chatId)
//
//   if (!chat.watchedPokemons) {
//     return
//   }
//
//   const possiblePokemons = Object.keys(chat.watchedPokemons)
//   const pokemonId = possiblePokemons[Math.floor(Math.random() * (possiblePokemons.length - 1)) + 1]
//   const minIv = chat.watchedPokemons[pokemonId]
//
//   const timeFrame = ([15, 30, 45, 60])[Math.floor(Math.random() * 3)]
//   const disappear_time = (new Date()).getTime() + ((timeFrame * 60 - Math.floor(Math.random() * 180)) * 1000)
//
//   const attack = Math.floor(Math.random() * 15) + 1
//   const defense = Math.floor(Math.random() * 15) + 1
//   const stamina = Math.floor(Math.random() * 15) + 1
//   const move1 = Moves[movesKeys[Math.floor(Math.random() * (movesKeys.length - 1))]]
//   const move2 = Moves[movesKeys[Math.floor(Math.random() * (movesKeys.length - 1))]]
//   const pokemon = Pokemons[pokemonId]
//   let iv = Math.round((attack + defense + stamina) * 100 / 45)
//
//   iv = iv < minIv ? (Math.floor(Math.random() * 100) + minIv) : iv
//
//   const disappearTime = new Date(disappear_time)
//   const disappearIn = new Date(disappear_time - (new Date()).getTime())
//   const shortDissappearTime = `${disappearIn.getMinutes()}min ${disappearIn.getSeconds()}s`
//   const longDissappearTime = `${('0' + disappearTime.getHours()).substr(-2)}:${('0' + disappearTime.getMinutes()).substr(-2)}:${('0' + disappearTime.getSeconds()).substr(-2)}`
//
//   let extendedInfo = [
//     longDissappearTime + ` (${shortDissappearTime})`,
//     `${move1.type} / ${move2.type}`
//   ]
//
//   console.log(`[ ${new Date().toLocaleString()} ] Sending trololo to ${chatId}, pokemon: ${pokemon.name}`)
//
//   return TelegramBot.sendVenue(
//     chatId,
//     latitude,
//     longitude,
//     `${pokemon.name} ${iv}%`,
//     extendedInfo.join(' ')
//   ).catch(err => handleFailedChat(chatId, err))
// }

function handleServiceSendToAllCommand(msg, match) {
  const chatId = msg.chat.id
  if (msg.from.id !== serviceUserId) return
  chats
    .filter(chat => chat.enabled)
    .map((chat, chatId) => {
      TelegramBot.sendMessage(chatId, match[1])
    })
}

function handleBanCommand(msg, match) {
  if (msg.from.id !== serviceUserId) return
  const id = match[1]
  TelegramBot.sendVideo(id, banGifUrl)
  console.log(id, 'got an Ban gif')
  if (!id.match('@')) {
    chatsRef.child(id).child('banned').set(true)
  }
}
function handleWarningCommand(msg, match) {
  if (msg.from.id !== serviceUserId) return
  const id = match[1]
  TelegramBot.sendVideo(id, warningGifUrl)
  console.log(id, 'got an Warning gif')
}

function handleInlineQuery(msg) {
  const query = String(msg.query).toLowerCase()
  let result = []
  if (query.length) {
    console.log(`Got inline query command for '${query}'`)
    Object.keys(Pokemons).map((pokemonId) => {
      const pokemon = Pokemons[pokemonId]
      if (pokemon.name.toLowerCase().indexOf(query) > -1) {
        result.push({
          type: 'article',
          id: pokemonId,
          title: `#${pokemonId} - ${pokemon.name}(${pokemon.rarity})`,
          input_message_content: {message_text: `/watch ${pokemonId}`}
        })
      }
    })
  }

  if (result.length) {
    TelegramBot.answerInlineQuery(msg.id, result)
  }
}