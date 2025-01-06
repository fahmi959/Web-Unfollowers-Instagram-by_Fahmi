const { IgApiClient } = require('instagram-private-api');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const express = require('express');
const axios = require('axios');
const router = express.Router();
const ig = new IgApiClient();

// Waktu pengaturan
const MIN_TIME_BETWEEN_REQUESTS = 2000; // Minimum 2 detik antara setiap permintaan
const MAX_TIME_BETWEEN_REQUESTS = 5000; // Maksimum 5 detik antara setiap permintaan
const TIME_BETWEEN_UNFOLLOWERS = 5000; // 5 detik antara setiap unfollow
const TIME_BETWEEN_SEARCH_WAIT = 15000; // 15 detik setelah lima siklus pencarian
const TIME_BETWEEN_UNFOLLOW_WAIT = 30000; // 30 detik setelah lima unfollow

// Fungsi untuk login ke Instagram
const login = async () => {
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
            console.log('Sesi kadaluarsa, login ulang...');
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
        console.log('Mencoba login...');
        await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
        console.log('Login berhasil!');
        const sessionData = ig.state.serialize();
        fs.writeFileSync(sessionPath, JSON.stringify(sessionData));
    } catch (error) {
        console.error('Login gagal:', error);
        if (error.name === 'IgCheckpointError') {
            const code = await promptFor2FACode();
            await ig.account.confirmTwoFactorCode(code);
            const sessionData = ig.state.serialize();
            fs.writeFileSync(sessionPath, JSON.stringify(sessionData));
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

        if (!fs.existsSync(imagePath)) {
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
        } else {
            console.log('Gambar profil sudah ada.');
        }

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

module.exports = router;
