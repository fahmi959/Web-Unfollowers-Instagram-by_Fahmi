const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors'); // Tambahkan import untuk CORS
const instagramRoutes = require('./routes/instagram'); // Import routing Instagram

dotenv.config(); // Memuat variabel dari file .env

const app = express();

// Menambahkan middleware CORS
app.use(cors()); // Secara default mengizinkan semua origin

// Menambahkan routing Instagram API
app.use('/api/v1/instagram', instagramRoutes);

// Menyajikan file HTML dari folder public
app.use(express.static(path.join(__dirname, 'public')));

// Atur route untuk file HTML utama
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html')); // Sesuaikan dengan path file HTML Anda
});

// Memulai server pada port 3000
app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});