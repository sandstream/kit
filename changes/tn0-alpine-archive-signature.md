### Security

- Kit verifies APKINDEX signatures against Alpine's pinned x86_64 keys before it uses package origin data.
- Kit checks the age of the signed index timestamp as well as the HTTP timestamp.
