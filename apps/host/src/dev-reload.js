new EventSource("http://localhost:4103/events").onmessage = () => location.reload()
