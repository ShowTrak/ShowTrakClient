

async function Main() {
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
