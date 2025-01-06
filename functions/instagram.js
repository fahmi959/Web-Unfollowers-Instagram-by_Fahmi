const { IgApiClient } = require('instagram-private-api');
const { db } = require('./config/firebaseConfig');
const ig = new IgApiClient();

// Variabel sesi yang disimpan dalam Firebase
let sessionData = null;

// Fungsi untuk menambahkan delay acak dalam rentang tertentu
const sleep = (min, max) => new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));

// Fungsi untuk menangani exponential backoff
const exponentialBackoff = (retries) => sleep(Math.pow(2, retries) * 1000, Math.pow(2, retries) * 2000);

// Fungsi untuk login dengan penanganan sesi dan checkpoint otomatis
const login = async () => {
    ig.state.generateDevice(process.env.INSTAGRAM_USERNAME);

    if (process.env.PROXY_URL) {
        ig.request.defaults.proxy = process.env.PROXY_URL;
    }

    if (sessionData) {
        ig.state.deserialize(sessionData);
        console.log('Sesi ditemukan, mencoba melanjutkan...');
        try {
            await ig.account.currentUser();
            console.log('Sesi valid, melanjutkan...');
        } catch (error) {
            console.log('Sesi tidak valid, mencoba login ulang...');
            await forceLogin();
        }
    } else {
        console.log('Sesi tidak ditemukan, mencoba login ulang...');
        await forceLogin();
    }
};

// Fungsi untuk login ulang dan menyimpan sesi di Firebase
const forceLogin = async () => {
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
        try {
            console.log('Mencoba login...');
            await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);

            sessionData = ig.state.serialize();
            await db.ref('sessions').child(process.env.INSTAGRAM_USERNAME).set({ sessionData });

            console.log('Login berhasil!');
            return;
        } catch (error) {
            console.error('Login gagal:', error);

            if (error.name === 'IgCheckpointError') {
                console.log('Instagram memerlukan verifikasi checkpoint...');
                await handleCheckpoint();
                return;
            }

            if (error.name === 'IgLoginRequiredError') {
                console.error('Login gagal: Username atau password salah.');
                throw new Error('Instagram login failed: Incorrect username or password.');
            }

            retries++;
            console.log(`Percobaan login ke-${retries} gagal. Menunggu sebelum mencoba lagi...`);
            await exponentialBackoff(retries);
        }
    }

    throw new Error('Login gagal setelah beberapa kali percobaan.');
};

// Fungsi untuk menangani checkpoint
const handleCheckpoint = async () => {
    const checkpoint = await ig.challenge.auto(true);
    console.log('Mendapatkan checkpoint:', checkpoint);

    if (checkpoint.step_name === 'select_verify_method') {
        await ig.challenge.selectVerifyMethod('email'); // Anda juga dapat memilih 'phone'
        console.log('Kode verifikasi dikirimkan ke email.');
    }

    if (checkpoint.step_name === 'verify_code') {
        const code = await getCodeFromUser(); // Fungsi ini diharapkan menangani input kode dari pengguna
        await ig.challenge.sendSecurityCode(code);
        console.log('Checkpoint berhasil diverifikasi.');
    }
};

// Fungsi untuk mendapatkan kode verifikasi dari pengguna
const getCodeFromUser = async () => {
    // Implementasikan metode untuk mendapatkan input kode dari pengguna (misalnya via CLI atau UI)
    console.log('Masukkan kode verifikasi yang dikirim ke email/telepon Anda:');
    return new Promise(resolve => {
        process.stdin.once('data', data => resolve(data.toString().trim()));
    });
};

// Fungsi untuk mengambil semua followers dengan paginasi
const getAllFollowers = async (userId) => {
    let followers = [];
    let followersFeed = ig.feed.accountFollowers(userId);

    do {
        let nextFollowers = await followersFeed.items();
        followers = followers.concat(nextFollowers);
        await sleep(5000, 10000); // Delay antara 5-10 detik
    } while (followersFeed.isMoreAvailable());

    return followers;
};

// Fungsi untuk mengambil semua following dengan paginasi
const getAllFollowing = async (userId) => {
    let following = [];
    let followingFeed = ig.feed.accountFollowing(userId);

    do {
        let nextFollowing = await followingFeed.items();
        following = following.concat(nextFollowing);
        await sleep(5000, 10000); // Delay antara 5-10 detik
    } while (followingFeed.isMoreAvailable());

    return following;
};

// Fungsi utama handler untuk API
exports.handler = async function(event, context) {
    if (event.httpMethod === 'GET' && event.path === '/.netlify/functions/instagram/profile') {
        try {
            await login();
            const user = await ig.account.currentUser();

            const followersCount = await ig.user.info(user.pk).then(info => info.follower_count);
            const followingCount = await ig.user.info(user.pk).then(info => info.following_count);
            const profilePicUrl = user.profile_pic_url;

            const [followers, following] = await Promise.all([
                getAllFollowers(user.pk),
                getAllFollowing(user.pk)
            ]);

            const followersUsernames = followers.map(f => f.username);
            const followingUsernames = following.map(f => f.username);

            const followersSet = new Set(followersUsernames);
            const followingSet = new Set(followingUsernames);

            const dontFollowBack = Array.from(followingSet).filter(following => !followersSet.has(following));

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
            return {
                statusCode: error.name === 'IgLoginRequiredError' ? 401 : 500,
                body: JSON.stringify({ message: error.message || 'Error fetching Instagram data' }),
            };
        }
    }

    return {
        statusCode: 404,
        body: JSON.stringify({ message: 'Not Found' }),
    };
};
