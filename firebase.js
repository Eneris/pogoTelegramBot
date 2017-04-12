import Firebase from 'firebase-admin'
import config from './config.json'

const app = Firebase.initializeApp({
  credential: Firebase.credential.cert(config.FB_SERVICE_ACCOUNT),
  databaseURL: config.FB_DATABASE_URL,
  // databaseAuthVariableOverride: {
  //   uid: "vps"
  // }
})

export default Firebase.database()
