const admin = require('firebase-admin');

// Pastikan jalur ke file serviceAccountKey.json benar
const serviceAccount = require('./serviceAccountKey.json'); 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://insta-unfoll-fahmi-default-rtdb.firebaseio.com'  // Ganti dengan URL Realtime Database Anda
});

const db = admin.database();

module.exports = db;
