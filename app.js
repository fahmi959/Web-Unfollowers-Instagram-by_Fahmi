const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const instagramRoutes = require('./routes/instagram');
const bodyParser = require('body-parser'); // Menggunakan body-parser untuk menerima data JSON
dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json()); // Menambahkan middleware bodyParser untuk mengurai JSON
app.use(express.static(path.join(__dirname, 'public')));

// Routing Instagram API
app.use('/api/v1/instagram', instagramRoutes);

// Atur route untuk file HTML utama
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint untuk login
app.post('/api/v1/instagram/login', async (req, res) => {
    const { username, password } = req.body;

    console.log('Request login diterima:', username, password);

    try {
        const ref = admin.database().ref('users');
        const snapshot = await ref.orderByChild('username').equalTo(username).once('value');
        
        if (snapshot.exists()) {
            const userData = snapshot.val();
            const user = Object.values(userData)[0]; // Ambil data user pertama yang ditemukan

            // Memeriksa password
            if (user.password === password) {
                console.log("Login berhasil, user ditemukan");
                return res.status(200).json({ message: 'Login sukses' });
            } else {
                console.log("Password salah");
                return res.status(401).json({ message: 'Password salah' });
            }
        } else {
            console.log("Username tidak ditemukan");
            return res.status(404).json({ message: 'Username tidak ditemukan' });
        }
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ message: 'Terjadi kesalahan saat login' });
    }
});


// Memulai server pada port 3000
app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
