const { IgApiClient } = require('instagram-private-api');
const axios = require('axios');
const path = require('path');
const { db } = require('./config/firebaseConfig');
const ig = new IgApiClient();

let sessionData = null;

// Fungsi untuk login ke Instagram
const login = async () => {
    ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);

    if (sessionData) {
        ig.state.deserialize(sessionData);
        console.log('Sesi ditemukan, melanjutkan...');
        try {
            await ig.account.currentUser();
            console.log('Sesi valid, melanjutkan...');
        } catch (error) {
            console.log('Sesi kadaluarsa, login ulang...');
            await forceLogin();
        }
    } else {
        console.log('Sesi tidak ditemukan, login ulang...');
        await forceLogin();
    }
};

// Fungsi untuk login ulang dan menyimpan sesi baru di Firebase
const forceLogin = async () => {
    try {
        console.log('Mencoba login...');
        await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
        console.log('Login berhasil!');
        sessionData = ig.state.serialize();
        await db.ref('sessions').child(process.env.INSTAGRAM_USERNAME).set({ sessionData });
    } catch (error) {
        console.error('Login gagal:', error);
        if (error.name === 'IgCheckpointError') {
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Instagram needs 2FA verification.' }),
            };
        } else {
            throw error;
        }
    }
};

// Fungsi untuk mendapatkan data followers dengan paginasi dan retry logic
const getAllFollowers = async (userId, retries = 3) => {
    let followers = [];
    let followersFeed = ig.feed.accountFollowers(userId);
    let attempt = 0;

    while (followersFeed.isMoreAvailable()) {
        try {
            let nextFollowers = await followersFeed.items();
            followers = followers.concat(nextFollowers);
            attempt = 0;
            await delay(generateRandomDelay()); // Menambah delay yang bervariasi
        } catch (error) {
            console.error('Error fetching followers:', error);
            if (attempt < retries) {
                attempt++;
                console.log(`Retrying attempt ${attempt}...`);
                await delay(5000);
            } else {
                throw new Error('Failed to fetch followers after multiple retries.');
            }
        }
    }
    return followers;
};

// Fungsi untuk mendapatkan data following dengan paginasi dan retry logic
const getAllFollowing = async (userId, retries = 3) => {
    let following = [];
    let followingFeed = ig.feed.accountFollowing(userId);
    let attempt = 0;

    while (followingFeed.isMoreAvailable()) {
        try {
            let nextFollowing = await followingFeed.items();
            following = following.concat(nextFollowing);
            attempt = 0;
            await delay(generateRandomDelay()); // Menambah delay yang bervariasi
        } catch (error) {
            console.error('Error fetching following:', error);
            if (attempt < retries) {
                attempt++;
                console.log(`Retrying attempt ${attempt}...`);
                await delay(5000);
            } else {
                throw new Error('Failed to fetch following after multiple retries.');
            }
        }
    }
    return following;
};

// Fungsi utama untuk menangani request profile Instagram
exports.handler = async function (event, context) {
    if (event.httpMethod === 'GET' && event.path === '/.netlify/functions/instagram/profile') {
        try {
            await login();
            const user = await ig.account.currentUser();

            // Mendapatkan jumlah followers dan following
            const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
            const followingCount = await ig.user.info(user.pk).then(info => info.following_count);

            // Mendapatkan gambar profil
            const profilePicUrl = user.profile_pic_url;

            // Ambil data followers dan following dengan tambahan waktu delay
            const followers = await getAllFollowers(user.pk);
            const following = await getAllFollowing(user.pk);

            // Menyaring usernames followers dan following
            const followersUsernames = followers.map(f => f.username);
            const followingUsernames = following.map(f => f.username);

            // Cari orang yang tidak follow back
            const dontFollowBack = followingUsernames.filter(username => !followersUsernames.includes(username));

            // Menyimpan data pengguna ke Firebase
            await db.ref('users').child(user.pk).set({
                username: user.username,
                full_name: user.full_name,
                followers_count: followersCount,
                following_count: followingCount,
                profile_picture_url: profilePicUrl,
                dont_follow_back_count: dontFollowBack.length,
            });

            return {
                statusCode: 200,
                body: JSON.stringify({
                    username: user.username,
                    full_name: user.full_name,
                    biography: user.biography,
                    followers_count: followersCount,
                    following_count: followingCount,
                    profile_picture_url: profilePicUrl,
                    dont_follow_back: dontFollowBack,
                    dont_follow_back_count: dontFollowBack.length,
                }),
            };
        } catch (error) {
            console.error('Error fetching Instagram data:', error);
            if (error.name === 'IgLoginRequiredError') {
                return {
                    statusCode: 401,
                    body: JSON.stringify({ message: 'Login is required. Please check your credentials.' }),
                };
            } else {
                return {
                    statusCode: 500,
                    body: JSON.stringify({ message: 'Error fetching Instagram data: ' + error.message }),
                };
            }
        }
    }

    return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Not Found' }),
    };
};

// Fungsi delay untuk menghindari rate limiting
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fungsi untuk menghasilkan delay acak antara 10 detik hingga 40 detik
const generateRandomDelay = () => {
    const minDelay = 10000; // 10 detik
    const maxDelay = 40000; // 40 detik
    return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
};
