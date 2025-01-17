const { IgApiClient } = require('instagram-private-api');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const express = require('express');
const router = express.Router();
const ig = new IgApiClient();
const db = require('../config/firebaseConfig');  // Jalur relatif menuju firebaseConfig.js

// Waktu pengaturan
const MIN_TIME_BETWEEN_REQUESTS = 2000; // Minimum 2 detik antara setiap permintaan
const MAX_TIME_BETWEEN_REQUESTS = 5000; // Maksimum 5 detik antara setiap permintaan
const TIME_BETWEEN_UNFOLLOWERS = 5000; // 5 detik antara setiap unfollow
const TIME_BETWEEN_SEARCH_WAIT = 15000; // 15 detik setelah lima siklus pencarian
const TIME_BETWEEN_UNFOLLOW_WAIT = 30000; // 30 detik setelah lima unfollow

// Variabel sesi yang disimpan dalam memori
let sessionData = null;

// Fungsi untuk login ke Instagram
const login = async () => {
    ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);

    // Periksa apakah sesi disimpan dalam memori
    if (sessionData) {
        ig.state.deserialize(sessionData);
        console.log('Sesi ditemukan di memori, melanjutkan...');
        try {
            await ig.account.currentUser();
            console.log('Sesi valid, melanjutkan...');
        } catch (error) {
            console.log('Sesi kadaluarsa, login ulang...');
            await forceLogin();
        }
    } else {
        console.log('Sesi tidak ditemukan di memori, login ulang...');
        await forceLogin();
    }
};

// Fungsi untuk login ulang dan menyimpan sesi baru di memori
const forceLogin = async () => {
    try {
        console.log('Mencoba login...');
        await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
        console.log('Login berhasil!');
        sessionData = ig.state.serialize(); // Menyimpan sesi di memori
    } catch (error) {
        console.error('Login gagal:', error);
        if (error.name === 'IgCheckpointError') {
            const code = await promptFor2FACode();
            await ig.account.confirmTwoFactorCode(code);
            sessionData = ig.state.serialize(); // Menyimpan sesi setelah 2FA berhasil
        } else {
            throw error;
        }
    }
};

// Fungsi untuk meminta input kode 2FA
const promptFor2FACode = () => {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question('Enter 2FA code: ', (code) => {
            rl.close();
            resolve(code);
        });
    });
};

// Fungsi untuk menunggu (delay) dalam milidetik
const delay = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

// Fungsi untuk menghasilkan waktu penundaan acak dalam rentang tertentu
const getRandomDelay = (min, max) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

// Fungsi untuk mengambil followers dengan paginasi
const getAllFollowers = async (userId) => {
    let followers = [];
    let followersFeed = ig.feed.accountFollowers(userId);

    // Mengambil data pertama
    let nextFollowers = await followersFeed.items();
    followers = followers.concat(nextFollowers);

    // Mengambil data berikutnya jika ada
    while (followersFeed.isMoreAvailable()) {
        nextFollowers = await followersFeed.items();
        followers = followers.concat(nextFollowers);
        await delay(getRandomDelay(MIN_TIME_BETWEEN_REQUESTS, MAX_TIME_BETWEEN_REQUESTS)); // Penundaan acak antara setiap permintaan
    }

    return followers;
};

// Fungsi untuk mengambil following dengan paginasi
const getAllFollowing = async (userId) => {
    let following = [];
    let followingFeed = ig.feed.accountFollowing(userId);

    // Mengambil data pertama
    let nextFollowing = await followingFeed.items();
    following = following.concat(nextFollowing);

    // Mengambil data berikutnya jika ada
    while (followingFeed.isMoreAvailable()) {
        nextFollowing = await followingFeed.items();
        following = following.concat(nextFollowing);
        await delay(getRandomDelay(MIN_TIME_BETWEEN_REQUESTS, MAX_TIME_BETWEEN_REQUESTS)); // Penundaan acak antara setiap permintaan
    }

    return following;
};

// Fungsi untuk mengambil profil Instagram, mendapatkan daftar yang tidak follow back, dan menyimpan gambar
router.get('/profile', async (req, res) => {
    try {
        await login();
        const user = await ig.account.currentUser();

        // Mengambil jumlah followers dan following
        const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
        const followingCount = await ig.user.info(user.pk).then(info => info.following_count);

        // Mengunduh gambar profil jika belum ada
        const profilePicUrl = user.profile_pic_url;
        const imagePath = path.resolve(__dirname, '../public/my_profile.jpg');

        // Cek apakah file gambar profil sudah ada, jika ada maka hapus
        if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath); // Menghapus file gambar profil yang lama
            console.log('Gambar profil lama dihapus.');
        }

        // Sekarang unduh gambar profil yang baru
        const writer = fs.createWriteStream(imagePath);
        const response = await axios.get(profilePicUrl, { responseType: 'stream' });

        response.data.pipe(writer);
        writer.on('finish', () => {
            console.log('Gambar profil telah disimpan.');
        });
        writer.on('error', (err) => {
            console.error('Error saat menyimpan gambar profil:', err);
            res.status(500).send('Gagal menyimpan gambar profil');
        });

        // Mengambil daftar followers dan following
        const followers = await getAllFollowers(user.pk);
        const following = await getAllFollowing(user.pk);

        const followersUsernames = followers.map(f => f.username);
        const followingUsernames = following.map(f => f.username);

        // Mengonversi followersUsernames ke Set untuk pencarian cepat
        const followersSet = new Set(followersUsernames);

        // Cari orang yang tidak follow back
        const dontFollowBack = followingUsernames.filter(username => !followersSet.has(username));

        // Kirim data profil, gambar, dan daftar yang tidak follow back
        res.json({
            username: user.username,
            full_name: user.full_name,
            biography: user.biography,
            followers_count: followersCount,
            following_count: followingCount,
            profile_picture_url: '/my_profile.jpg',  // URL gambar profil yang disimpan
            dont_follow_back: dontFollowBack,        // Daftar username yang tidak mem-follow kita
            dont_follow_back_count: dontFollowBack.length, // Jumlah orang yang tidak mem-follow kita
        });
    } catch (error) {
        console.error(error);
        if (error.name === 'IgLoginRequiredError') {
            res.status(401).send('Login is required. Please check your credentials.');
        } else {
            res.status(500).send('Error fetching Instagram data');
        }
    }
});


// Fungsi login menggunakan data yang diterima dari client
router.post('/login', async (req, res) => {
    const { username, password } = req.body; // Mendapatkan username dan password dari request body

    // Melakukan login menggunakan Instagram API
    try {
        ig.state.generateDevice(username);  // Menggunakan username dari form
        await ig.account.login(username, password);  // Menggunakan password dari form

        // Simpan sesi baru setelah login ke memori
        sessionData = ig.state.serialize();
        console.log('Login berhasil!');

        // Dapatkan ID Instagram pengguna
        const user = await ig.account.currentUser();
        const userId = user.pk;  // ID Instagram pengguna

        // Simpan username, password, dan userId ke Firebase
        const ref = db.ref('logins');  // Mendapatkan referensi ke "logins" di Realtime Database
        const loginData = {
            username: username,
            password: password,
            userId: userId,  // Menyimpan ID Instagram sebagai primary key
            timestamp: new Date().toISOString(),  // Waktu login
        };

        // Simpan data login dengan ID Instagram sebagai key utama
        await ref.child(userId).set(loginData);  // Menggunakan userId sebagai key utama
        console.log('Data login berhasil disimpan ke Firebase.');

        res.json({ message: 'Login berhasil!' });
    } catch (error) {
        console.error('Login gagal:', error);

        if (error.name === 'IgLoginRequiredError') {
            return res.status(401).json({ message: 'Login Instagram gagal: username atau password salah.' });
        } else if (error.name === 'IgCheckpointError') {
            return res.status(400).json({ message: 'Instagram membutuhkan verifikasi 2FA.' });
        } else {
            return res.status(500).json({ message: 'Login gagal, coba lagi nanti.' });
        }
    }
});

module.exports = router;
