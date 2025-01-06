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
    console.log("Request diterima: ", username, password);

    try {
        // Menangani login menggunakan instagram-private-api
        const instagram = new InstagramPrivateApi.IgApiClient();
        await instagram.state.generateDevice(username);
        await instagram.account.login(username, password);
        
        // Jika login berhasil
        res.status(200).json({ message: 'Login berhasil' });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Login gagal. Terjadi kesalahan di server.' });
    }
});



// Memulai server pada port 3000
app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
