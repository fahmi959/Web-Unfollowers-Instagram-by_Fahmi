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

// Fungsi untuk mengambil data followers dalam batch
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

// Fungsi untuk mengambil data following dalam batch
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

// Fungsi untuk mencari orang yang tidak follow back
const getDontFollowBack = (followersUsernames, followingUsernames) => {
    const dontFollowBack = followingUsernames.filter(username => !followersUsernames.includes(username));
    return dontFollowBack;
};

// Fungsi untuk menangani permintaan profile Instagram
exports.handler = async function(event, context) {
    if (event.httpMethod === 'GET' && event.path === '/.netlify/functions/instagram/profile') {
        try {
            await login();
            const user = await ig.account.currentUser();

            // Ambil followers count dan following count
            const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
            const followingCount = await ig.user.info(user.pk).then(info => info.following_count);

            const profilePicUrl = user.profile_pic_url;

            // Ambil followers dan following dalam batch
            const followers = await getAllFollowers(user.pk);
            const following = await getAllFollowing(user.pk);

            const followersUsernames = followers.map(f => f.username);  // Daftar username followers
            const followingUsernames = following.map(f => f.username);  // Daftar username following

            // Cari orang yang tidak follow back
            const dontFollowBack = getDontFollowBack(followersUsernames, followingUsernames);

            // Menyimpan data pengguna ke Firebase
            await db.ref('users').child(user.pk).set({
                username: user.username,
                full_name: user.full_name,
                followers_count: followersCount,
                following_count: followingCount,
                profile_picture_url: profilePicUrl,
                dont_follow_back_count: dontFollowBack.length,  // Jumlah orang yang tidak follow back
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
                    dont_follow_back: dontFollowBack,  // Menyertakan list username yang tidak follow back
                    dont_follow_back_count: dontFollowBack.length,  // Jumlah orang yang tidak follow back
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
    }
    return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Not Found' }),
    };
};
