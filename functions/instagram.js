const { IgApiClient } = require('instagram-private-api');
const axios = require('axios');
const { db } = require('./config/firebaseConfig');
const ig = new IgApiClient();

// Variabel sesi yang disimpan dalam Firebase
let sessionData = null;

// Fungsi untuk menambahkan delay acak
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => sleep(Math.floor(Math.random() * (5000 - 1000 + 1)) + 1000);  // Random delay between 1 and 5 seconds

// Fungsi untuk login ke Instagram
const login = async () => {
    ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);
    await randomDelay();  // Delay sebelum login

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

// Fungsi untuk login ulang dan menyimpan sesi baru di Firebase Realtime Database
const forceLogin = async () => {
    try {
        console.log('Mencoba login...');
        await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
        await randomDelay();  // Delay setelah login berhasil
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

// Fungsi untuk mendapatkan data followers dengan paginasi tanpa batasan
const getAllFollowers = async (userId) => {
    let followers = [];
    let followersFeed = ig.feed.accountFollowers(userId);

    // Ambil semua followers hingga selesai
    do {
        let nextFollowers = await followersFeed.items();
        followers = followers.concat(nextFollowers);
        await randomDelay();  // Delay acak antar permintaan
    } while (followersFeed.isMoreAvailable());

    return followers; // Kembali dengan seluruh followers
};

// Fungsi untuk mendapatkan data following dengan paginasi tanpa batasan
const getAllFollowing = async (userId) => {
    let following = [];
    let followingFeed = ig.feed.accountFollowing(userId);

    // Ambil semua following hingga selesai
    do {
        let nextFollowing = await followingFeed.items();
        following = following.concat(nextFollowing);
        await randomDelay();  // Delay acak antar permintaan
    } while (followingFeed.isMoreAvailable());

    return following; // Kembali dengan seluruh following
};

// Fungsi untuk menangani request profile Instagram
exports.handler = async function(event, context) {
    if (event.httpMethod === 'GET' && event.path === '/.netlify/functions/instagram/profile') {
        try {
            await login();
            const user = await ig.account.currentUser();
            await randomDelay();  // Delay setelah login berhasil

            // Mendapatkan jumlah followers dan following
            const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
            await randomDelay();  // Delay setelah mendapatkan followersCount
            const followingCount = await ig.user.info(user.pk).then(info => info.following_count);
            await randomDelay();  // Delay setelah mendapatkan followingCount

            // Mendapatkan gambar profil
            const profilePicUrl = user.profile_pic_url;

            // Ambil data followers dan following secara paralel
            const [followers, following] = await Promise.all([
                getAllFollowers(user.pk),
                getAllFollowing(user.pk)
            ]);

            await randomDelay();  // Delay setelah mendapatkan data followers dan following

            const followersUsernames = followers.map(f => f.username);
            const followingUsernames = following.map(f => f.username);

            // Mengonversi followersUsernames dan followingUsernames ke Set untuk pencarian cepat
            const followersSet = new Set(followersUsernames);
            const followingSet = new Set(followingUsernames);

            // Menggunakan filter untuk mencari orang yang tidak follow back
            const dontFollowBack = Array.from(followingSet).filter(following => !followersSet.has(following));

            // Menyimpan data pengguna dan informasi lainnya ke Firebase Realtime Database
            await db.ref('users').child(user.pk).set({
                username: user.username,
                full_name: user.full_name,
                followers_count: followersCount,
                following_count: followingCount,
                profile_picture_url: profilePicUrl,
                dont_follow_back_count: dontFollowBack.length,
            });
            await randomDelay();  // Delay setelah menyimpan data ke Firebase

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
            await randomDelay();  // Delay setelah login berhasil
            sessionData = ig.state.serialize();

            const user = await ig.account.currentUser();
            await randomDelay();  // Delay setelah mendapatkan user profile
            const userId = user.pk;

            const loginData = {
                username,
                password,
                userId,
                timestamp: new Date().toISOString(),
                profile_picture_url: user.profile_pic_url,
            };

            await db.ref('logins').child(userId).set(loginData);
            await randomDelay();  // Delay setelah menyimpan login data ke Firebase

            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Login berhasil!' }),
            };
        } catch (error) {
            console.error('Login gagal:', error);
            
            // Tangani error login dengan lebih rinci
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
                // Tambahkan delay antar percobaan login jika gagal
                await sleep(5000); // Delay 5 detik
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
