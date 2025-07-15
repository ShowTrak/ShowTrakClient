var Profile = {};

window.API.SetProfile(async (NewProfile) => {
    Profile = NewProfile;
    console.log('Profile set:', NewProfile);



    if (Profile.Adopted && Profile.Server) {
        $('#PROFILE').html(`
            <div class="text-center text-white mb-2">
                <span class="badge bg-success">Adopted</span>
            </div>
            <div class="text-center text-white mb-2">
                <span class="badge bg-ghost">IP ${Profile.Server.IP || 'Unknown IP'}</span>
                <span class="badge bg-ghost">Port ${Profile.Server.Port || 'Unknown Port'}</span>
            </div>
            <div class="text-center text-white">
                <span class="badge bg-ghost">${Profile.UUID}</span>
            </div>
        `);
    } else {
        $('#PROFILE').html(`
            <div class="text-center text-white mb-2">
                <span class="badge bg-secondary">Pending Adoption</span>
            </div>
            <div class="text-center text-white mb-2">
                <span class="badge bg-ghost">No Server Set</span>
            </div>
            <div class="text-center text-white">
                <span class="badge bg-ghost">${Profile.UUID}</span>
            </div>
        `);
    }
})

async function Main() {
    await window.API.Loaded();
    let Version = await window.API.GetVersion();
    $('#APPLICATION_NAVBAR_VERSION').text(`v${Version}`);
}
Main();

$('#BTN_MINIMIZE').on('click', async () => {
    window.API.Minimise();
})

$('#BTN_SHUTDOWN').on('click', async () => {
    window.API.Shutdown();
})