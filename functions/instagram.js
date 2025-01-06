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

// Fungsi untuk mendapatkan data followers dengan paginasi yang terbatas
const getAllFollowers = async (userId) => {
    let followers = [];
    let after = null;
    let hasNext = true;

    while (hasNext) {
        const followersFeed = await ig.feed.accountFollowers(userId, 50, after).items();
        followers = followers.concat(followersFeed);
        hasNext = followersFeed.length === 50;
        after = hasNext ? followersFeed[followersFeed.length - 1].pk : null;
    }

    return followers.map(f => f.username);
};

// Fungsi untuk mendapatkan data following dengan paginasi yang terbatas
const getAllFollowing = async (userId) => {
    let following = [];
    let after = null;
    let hasNext = true;

    while (hasNext) {
        const followingFeed = await ig.feed.accountFollowing(userId, 50, after).items();
        following = following.concat(followingFeed);
        hasNext = followingFeed.length === 50;
        after = hasNext ? followingFeed[followingFeed.length - 1].pk : null;
    }

    return following.map(f => f.username);
};

// Fungsi untuk menangani request profile Instagram
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

            // Ambil data followers dan following secara paralel dengan batasan jumlah
            const [followers, following] = await Promise.all([ 
                getAllFollowers(user.pk),
                getAllFollowing(user.pk)
            ]);

            // Menentukan siapa yang tidak follow back
            const followersSet = new Set(followers);
            const followingSet = new Set(following);

            const dontFollowBack = [...followingSet].filter(followingUsername => !followersSet.has(followingUsername));
            const iDontFollowBack = [...followersSet].filter(followerUsername => !followingSet.has(followerUsername));

            // Menyimpan data pengguna dan informasi lainnya ke Firebase Realtime Database
            await db.ref('users').child(user.pk).set({
                username: user.username,
                full_name: user.full_name,
                followers_count: followersCount,
                following_count: followingCount,
                profile_picture_url: profilePicUrl,
                dont_follow_back_count: dontFollowBack.length,
                i_dont_follow_back_count: iDontFollowBack.length,
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
                    i_dont_follow_back: iDontFollowBack,
                    i_dont_follow_back_count: iDontFollowBack.length,
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
