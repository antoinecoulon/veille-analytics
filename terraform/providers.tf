terraform {
  required_version = ">= 1.5"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

# Le provider s'authentifie via la variable d'environnement CLOUDFLARE_API_TOKEN
# (aucun token en clair dans le code, cf. README). L'account_id est passé par ressource.
provider "cloudflare" {}
