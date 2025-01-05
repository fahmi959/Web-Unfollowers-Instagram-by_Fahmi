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
    console.log('Menerima request GET di /');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Memulai server pada port 3000
app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
