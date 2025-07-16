var Profile = {};
var Version = '0.0.0';

async function Main() {
    await window.API.Loaded();
    Version = await window.API.GetVersion();
    $('#APPLICATION_NAVBAR_TITLE').text(`ShowTrak Client v${Version}`);
}
Main();

window.API.SetProfile(async (NewProfile) => {
    Profile = NewProfile;
    Version = await window.API.GetVersion();
    console.log('Profile set:', NewProfile);
    if (Profile.Adopted && Profile.Server) {
        $('#PROFILE').html(`
            <div class="text-center text-white mb-2">
                <span class="badge bg-success">Adopted</span>
            </div>
            <div class="text-center text-white mb-2">
                <span class="badge bg-ghost">${Profile.Server.IP || 'Unknown IP'}</span>
                <span class="badge bg-ghost">${Profile.Server.Port || 'Unknown Port'}</span>
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


$('#BTN_MINIMIZE').on('click', async () => {
    window.API.Minimise();
})

$('#BTN_SHUTDOWN').on('click', async () => {
    window.API.Shutdown();
})