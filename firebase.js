import Firebase from 'firebase-admin'
import config from './config.json'

const app = Firebase.initializeApp({
  credential: Firebase.credential.cert({
    private_key: config.FB_PRIVATE_KEY || process.env.FB_PRIVATE_KEY,
    client_email: config.FB_CLIENT_EMAIL || process.env.FB_CLIENT_EMAIL
  }),
  databaseURL: config.FB_DATABASE_URL,
  databaseAuthVariableOverride: {
    uid: "vps"
  }
})

export default Firebase.database()
