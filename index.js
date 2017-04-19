import Pokemons from './static/pokemon.json'
import Moves from './static/moves.json'
import moment from 'moment'
import TelegramBot from './telegramBot'
import config from './config.json'
import fb from './firebase'
import {fromJS} from 'immutable'

const DEBUG = process.env.DEBUG || config.DEBUG

let initialLoadCompleted = false
let notificationsEnabled = false

let chats = fromJS({})
let serviceChatId = null

const onlineRef = fb.ref('/config/bot/status')
const chatsRef = fb.ref('/config/bot/chats')
const chatsRefFiltered = fb.ref('/config/bot/chats').orderByChild('enabled').equalTo(true)
const enabledRef = fb.ref('/config/bot/enabled')
const pokemonsRef = fb.ref('/data/pokemons').orderByChild('last_modified').startAt((new Date()).valueOf())
const serviceChatRef = fb.ref('/config/bot/serviceChatId')

onlineRef.set('starting')
onlineRef.onDisconnect().set('offline')

chatsRefFiltered.once('value', snap => {
  chats = fromJS(snap.val() || {}).map(item => item.toJS())
  initialLoadCompleted = true
  onlineRef.set('online')
  console.log('Initial load complete...', chats.size, 'chats found')
})

serviceChatRef.on('value', serviceChatIdSnap => serviceChatId = serviceChatIdSnap.val())

chatsRefFiltered.on('child_added', chatsSnap => {
  console.log("Chat added", chatsSnap.key)
  chats = chats.set(chatsSnap.key, chatsSnap.val())
})
chatsRefFiltered.on('child_changed', chatsSnap => {
  console.log("Chat changed", chatsSnap.key)
  chats = chats.set(chatsSnap.key, chatsSnap.val())
})
chatsRefFiltered.on('child_removed', chatsSnap => {
  console.log("Chat removed", chatsSnap.key)
  chats = chats.remove(chatsSnap.key)
})

enabledRef.on('value', botEnabledSnap => {
  const enabled = DEBUG ? false : botEnabledSnap.val()
  console.log('Notifications ' + (enabled ? 'enabled' : 'disabled'))
  notificationsEnabled = enabled
})

// TODO: theta Změnit uzel (Do "pokealarm" zapisuje PokeTrack)
pokemonsRef.on('child_added', pokemonSnap => {
  if (!initialLoadCompleted && true) return

  const props = pokemonSnap.val()
  const key = pokemonSnap.key
  sendNewPokemon(key, props) // RocketMap
  // sendNewPokemon2(key, props) // PokeTrack
})

// Message listeners
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
TelegramBot.on('inline_query', (msg/*, match*/) => handleInlineQuery(msg/*, match*/))
TelegramBot.on('location', (msg/*, match*/) => handleSetLocationCommand(msg/*, match*/))

// Functions
function getDistance(lat1, lon1, lat2, lon2) {
  let R = 6371; // Radius of the earth in km
  let dLat = (lat2 - lat1) * Math.PI / 180;  // deg2rad below
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
  } else if (serviceChatId) {
    TelegramBot.sendMessage(serviceChatId, `Failed chat message: \n${err.error_code}: ${err.description}`)
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

// TODO: Theto zkontroluj strukturu dat
function sendNewPokemon(encounterId, props) {
  // const pokemon = Pokemons[props.pokemon_id]
  const disappearTime = new Date(props.disappear_time)
  const disappearIn = new Date(props.disappear_time - (new Date()).getTime())
  const shortDissappearTime = `${disappearIn.getMinutes()}min ${disappearIn.getSeconds()}s`
  const longDissappearTime = `${('0' + disappearTime.getHours()).substr(-2)}:${('0' + disappearTime.getMinutes()).substr(-2)}:${('0' + disappearTime.getSeconds()).substr(-2)}`
  let attack = props.individual_attack
  let defense = props.individual_defense
  let stamina = props.individual_stamina
  let iv = (attack >= 0 && defense >= 0 && stamina >= 0) ? Math.round((attack + defense + stamina) * 100 / 45) : undefined

  chats.map((chat, chatId) => {
    const minIv = chat.watchedPokemons && chat.watchedPokemons[props.pokemon_id]
    if (minIv === undefined || minIv === null) return // Return if record in watchedPokemons doesn't exist
    if (iv === undefined && minIv > 0) return // return if filter is over 0 and we don't have IV
    if (iv >= 0 && iv < minIv) return // Return if pokemon has IV and watched higher

    const latitude = chat.filterLocation && chat.filterLocation.latitude || 49.195156
    const longitude = chat.filterLocation && chat.filterLocation.longitude || 16.608267
    const distance = chat.filterLocation && chat.filterLocation.distance || 3

    if (getDistance(props.latitude, props.longitude, latitude, longitude) > distance) return

    if (notificationsEnabled) {
      console.log(`[ ${new Date().toLocaleString()} ] Send pokemon ${encounterId} ${props.pokemon_name} IV ${iv >= 0 ? iv : '??'}% - #${props.pokemon_id} notification to ${chatId}`)

      // let extendedInfo = [
      //   `${props.pokemon_name} IV: ${iv ? iv : '??'}%`,
      //   `Time left: ${shortDissappearTime}`,
      //   `Disappears at: ${longDissappearTime}`
      // ]

      // if (iv) {
      //   extendedInfo.push(`IV: ${iv ? iv : '??'}% (${props.individual_attack}/${props.individual_defense}/${props.individual_stamina})`)
      // }

      // if (props.move_1) {
      //   const move1 = Moves[props.move_1]
      //   extendedInfo.push(`Move 1: ${move1.name}(${move1.type})`)
      // }

      // if (props.move_2) {
      //   const move2 = Moves[props.move_2]
      //   extendedInfo.push(`Move 2: ${move2.name}(${move2.type})`)
      // }

      let extendedInfo = [
        longDissappearTime + ` (${shortDissappearTime})`
      ]

      if (props.move_1 && props.move_2) {
        const move1 = Moves[props.move_1]
        const move2 = Moves[props.move_2]
        extendedInfo.push(`${move1.type} / ${move2.type}`)
      }

      return TelegramBot.sendVenue(
        chatId,
        props.latitude,
        props.longitude,
        `${props.pokemon_name} ${iv !== undefined ? ` - ${iv}%` : ''}`,
        extendedInfo.join(' ')
      ).catch(err => handleFailedChat(chatId, err))

      // return TelegramBot.sendMessage(chatId, extendedInfo.join("\n"))
      //   .then(() => TelegramBot.sendLocation(chatId, props.latitude, props.longitude, {"disable_notification": true}))
      //   .catch(err => handleFailedChat(chatId, err))
    }
  })
}

// Command handlers

function handleWatchCommand(msg, match) {
  const chatId = msg.chat.id.toString()

  const params = match[1].trim().split(' ').map(item => parseInt(item))
  // Pokemon iv == params[2]

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

    // if (false && !pokemon.rarity.match(/Rare/)) {
    //   TelegramBot.sendMessage(chatId, `Watching anything less than Rare is not allowed! ${pokemon.name} is ${pokemon.rarity}`, {
    //     "reply_to_message_id": msg.message_id,
    //     "disable_notification": true
    //   })
    //   return false
    // }

    const chat = chats.get(chatId)
    if (!chat) {
      TelegramBot.sendMessage(chatId, 'Bot is not started here. Please send /start', {
        "reply_to_message_id": msg.message_id,
        "disable_notification": true
      })
      return
    }

    // if (chat.watchedPokemons && chat.watchedPokemons[pokemon.id] !== undefined && chat.watchedPokemons[pokemon.id] === minIv) {
    //   TelegramBot.sendMessage(chatId, `Already watching ${pokemon.name}`, {
    //     "reply_to_message_id": msg.message_id,
    //     "disable_notification": true
    //   })
    //   return
    // }

    const savedMinIv = chat.watchedPokemons && chat.watchedPokemons[pokemon.id]
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
    const chat = chats.get(chatId)
    const watchedPokemons = chat.watchedPokemons && Object.keys(chat.watchedPokemons).map(pokemonId => {
        const pokemon = Pokemons[pokemonId]
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
    TelegramBot.sendMessage(chatId, "Location saved", {"reply_to_message_id": msg.message_id, "disable_notification": true})
  }, () => sendAccessDenied(chatId, msg.message_id))
}

function handleSetLocationDistanceCommand(msg, match, isGetter) {
  checkAccessRights(msg, () => {
    const chatId = msg.chat.id.toString()
    const chat = chats.get(chatId)

    if (isGetter) {
      if (chat.filterLocation && chat.filterLocation.distance)
        return TelegramBot.sendMessage(chatId, `Your current filter distance is ${chat.filterLocation.distance}km`)
      else
        return TelegramBot.sendMessage(chatId, `Your filter distance is to infinity and beyond...`)
    } else {
      const distance = parseFloat(match[1])
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

function handleServiceSendToAllCommand(msg, match) {
  const chatId = msg.chat.id
  if (chatId == serviceChatId) {
    chats.map((chat, chatId) => {
      // if (chat.enabled) {
        TelegramBot.sendMessage(chatId, match[1])
      // }
    })
  }
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