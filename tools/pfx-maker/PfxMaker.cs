// PFX Maker -- plak een certificaat en een private sleutel, krijg een .pfx.
//
// IIS importeert geen los certificaat plus sleutel; dat moet één PKCS#12-bestand
// zijn. De gebruikelijke weg daarheen is `openssl pkcs12 -export`, maar openssl
// staat niet op een kale Windows Server. Dit doet dezelfde conversie met wat er
// in .NET Framework zit, zodat je niets hoeft te installeren.
//
// Bouwen:  build.cmd   (gebruikt de csc.exe die bij Windows zit)
//
// De sleutel wordt nergens weggeschreven behalve in de .pfx die jij aanwijst,
// en niet gelogd. Dat is bewust: dit gereedschap bestaat juist omdat sleutels
// te makkelijk op de verkeerde plek belanden.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class Program
{
    // Een winexe heeft geen console. Zonder dit zie je bij de commandoregel-modus
    // helemaal niets terug, ook geen foutmelding.
    [DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int processId);

    /// <summary>
    /// Zonder argumenten opent het venster. Met vier argumenten doet hij dezelfde
    /// conversie zonder venster, zodat dit ook in een script past -- en zodat de
    /// omzetting te testen is zonder dat er iemand hoeft te klikken.
    /// </summary>
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new HoofdVenster());
            return 0;
        }

        AttachConsole(-1); // -1 = de console van wie ons startte

        if (args.Length != 4)
        {
            Console.Error.WriteLine("Gebruik: PfxMaker.exe <cert.pem> <key.pem> <wachtwoord> <uit.pfx>");
            Console.Error.WriteLine("Zonder argumenten opent het venster.");
            return 2;
        }

        try
        {
            byte[] pfx = Omzetter.NaarPfx(
                File.ReadAllText(args[0]),
                File.ReadAllText(args[1]),
                args[2]);

            File.WriteAllBytes(args[3], pfx);
            Console.WriteLine("Klaar: " + args[3] + " (" + pfx.Length + " bytes)");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("Mislukt: " + ex.Message);
            return 1;
        }
    }
}

/// <summary>
/// De eigenlijke omzetting, los van het venster zodat beide wegen dezelfde code
/// gebruiken. Een tweede implementatie voor de commandoregel zou betekenen dat
/// je maar één van de twee test.
/// </summary>
internal static class Omzetter
{
    public static byte[] NaarPfx(string certTekst, string keyTekst, string wachtwoord)
    {
        byte[] certDer = Pem.Blok(certTekst, "CERTIFICATE");
        if (certDer == null)
        {
            var g = Pem.Namen(certTekst);
            throw new InvalidDataException(g.Count == 0
                ? "Geen CERTIFICATE-blok gevonden."
                : "Geen CERTIFICATE-blok. Wel gevonden: " + string.Join(", ", g.ToArray()));
        }

        RSAParameters sleutel;
        byte[] pkcs8 = Pem.Blok(keyTekst, "PRIVATE KEY");
        byte[] pkcs1 = Pem.Blok(keyTekst, "RSA PRIVATE KEY");

        if (pkcs8 != null) sleutel = SleutelLezer.UitPkcs8(pkcs8);
        else if (pkcs1 != null) sleutel = SleutelLezer.UitPkcs1(pkcs1);
        else
        {
            var g = Pem.Namen(keyTekst);
            if (g.Contains("EC PRIVATE KEY"))
                throw new InvalidDataException("Dit is een EC-sleutel; dit gereedschap kan alleen RSA.");
            if (g.Contains("ENCRYPTED PRIVATE KEY"))
                throw new InvalidDataException("Deze sleutel is zelf met een wachtwoord versleuteld.");
            throw new InvalidDataException(g.Count == 0
                ? "Geen PRIVATE KEY-blok gevonden."
                : "Geen bruikbaar sleutelblok. Wel gevonden: " + string.Join(", ", g.ToArray()));
        }

        if (string.IsNullOrEmpty(wachtwoord))
            throw new InvalidDataException("Een wachtwoord is verplicht; IIS vraagt erom bij het importeren.");

        var cert = new X509Certificate2(certDer);

        // De sleutel moet in een echte CSP-container staan, niet alleen in het
        // geheugen: X509Certificate2.PrivateKey weigert anders met "Keyset does
        // not exist". Vandaar een container met een eigen naam.
        //
        // ProviderType 24 is PROV_RSA_AES; type 1 (PROV_RSA_FULL) kan geen SHA-2
        // en dan klapt de export op een modern certificaat.
        //
        // Geen UseMachineKeyStore: dat vraagt beheerdersrechten en dit hoort te
        // werken als gewone gebruiker.
        var csp = new CspParameters(24);
        csp.KeyContainerName = "pfxmaker-" + Guid.NewGuid().ToString("N");

        var rsa = new RSACryptoServiceProvider(csp);
        rsa.ImportParameters(sleutel);

        // Controleer dat de sleutel echt bij dit certificaat hoort. Zonder deze
        // controle levert een verkeerd geplakte combinatie een .pfx op die IIS
        // pas veel later weigert, en dan zoek je in de verkeerde hoek.
        //
        // Bewust GEEN using hieromheen: cert.PublicKey.Key geeft een handle die
        // het certificaat zelf nog gebruikt. Afsluiten laat de toewijzing van de
        // private sleutel hieronder stuklopen op "Safe handle has been closed".
        var publiek = cert.PublicKey.Key as RSACryptoServiceProvider;
        if (publiek == null)
            throw new InvalidDataException("Dit certificaat gebruikt geen RSA; dit gereedschap kan alleen RSA.");

        if (Convert.ToBase64String(publiek.ExportParameters(false).Modulus)
            != Convert.ToBase64String(rsa.ExportParameters(false).Modulus))
        {
            throw new InvalidDataException(
                "Deze sleutel hoort niet bij dit certificaat. Haal ze allebei uit hetzelfde Cloudflare-certificaat.");
        }

        cert.PrivateKey = rsa;

        try
        {
            return cert.Export(X509ContentType.Pfx, wachtwoord);
        }
        finally
        {
            // De container weer weghalen. Zonder dit blijft de private sleutel
            // achter in het sleutelarchief van de gebruiker -- op elke machine
            // waar dit gereedschap ooit gedraaid heeft. Voor een programma dat
            // juist bestaat om sleutels netjes te behandelen is dat het laatste
            // wat je wilt.
            rsa.PersistKeyInCsp = false;
            rsa.Clear();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ASN.1: net genoeg om een RSA-sleutel uit te pakken.
//
// Een PEM-sleutel is base64 om een DER-structuur heen. PKCS#8 verpakt de echte
// sleutel nog een laag dieper dan PKCS#1, en Cloudflare levert PKCS#8. .NET
// Framework heeft geen ImportPkcs8PrivateKey -- dat kwam pas in .NET Core -- dus
// die laag pellen we hier met de hand.
// ─────────────────────────────────────────────────────────────────────────────
internal sealed class Asn1Lezer
{
    private readonly byte[] _data;
    private int _pos;

    public Asn1Lezer(byte[] data) { _data = data; _pos = 0; }

    private byte LeesByte()
    {
        if (_pos >= _data.Length) throw new InvalidDataException("onverwacht einde van de structuur");
        return _data[_pos++];
    }

    /// <summary>Leest de lengte, die kort (één byte) of lang (meerdere) kan zijn.</summary>
    private int LeesLengte()
    {
        int eerste = LeesByte();
        if ((eerste & 0x80) == 0) return eerste;

        int aantal = eerste & 0x7F;
        if (aantal == 0 || aantal > 4) throw new InvalidDataException("onbruikbare lengte");

        int lengte = 0;
        for (int i = 0; i < aantal; i++) lengte = (lengte << 8) | LeesByte();
        if (lengte < 0) throw new InvalidDataException("onbruikbare lengte");
        return lengte;
    }

    /// <summary>Stapt een tag in en geeft de inhoud terug.</summary>
    public byte[] Lees(byte verwachteTag)
    {
        byte tag = LeesByte();
        if (tag != verwachteTag)
            throw new InvalidDataException(string.Format("verwachtte tag 0x{0:X2}, kreeg 0x{1:X2}", verwachteTag, tag));

        int lengte = LeesLengte();
        if (_pos + lengte > _data.Length) throw new InvalidDataException("lengte wijst buiten de structuur");

        byte[] inhoud = new byte[lengte];
        Array.Copy(_data, _pos, inhoud, 0, lengte);
        _pos += lengte;
        return inhoud;
    }

    public byte[] LeesSequence() { return Lees(0x30); }

    /// <summary>
    /// Een INTEGER in DER is signed en heeft daarom soms een nulbyte vooraan.
    /// RSAParameters wil die niet, en wil bovendien een vaste lengte.
    /// </summary>
    public byte[] LeesInteger(int lengte)
    {
        byte[] rauw = Lees(0x02);

        int start = 0;
        while (start < rauw.Length - 1 && rauw[start] == 0x00) start++;
        int echteLengte = rauw.Length - start;

        if (lengte <= 0)
        {
            byte[] kaal = new byte[echteLengte];
            Array.Copy(rauw, start, kaal, 0, echteLengte);
            return kaal;
        }

        if (echteLengte > lengte)
            throw new InvalidDataException("getal is groter dan verwacht voor deze sleutellengte");

        // Links aanvullen met nullen: RSAParameters verwacht vaste breedtes.
        byte[] uit = new byte[lengte];
        Array.Copy(rauw, start, uit, lengte - echteLengte, echteLengte);
        return uit;
    }

    public void Overslaan(byte tag) { Lees(tag); }
}

internal static class Pem
{
    /// <summary>Haalt het eerste blok met deze naam uit een lap tekst.</summary>
    public static byte[] Blok(string tekst, params string[] namen)
    {
        foreach (string naam in namen)
        {
            var m = Regex.Match(
                tekst,
                "-----BEGIN " + Regex.Escape(naam) + "-----(.*?)-----END " + Regex.Escape(naam) + "-----",
                RegexOptions.Singleline);

            if (m.Success)
            {
                string body = Regex.Replace(m.Groups[1].Value, @"\s+", "");
                try { return Convert.FromBase64String(body); }
                catch (FormatException) { throw new InvalidDataException("het " + naam + "-blok bevat geen geldige base64"); }
            }
        }
        return null;
    }

    /// <summary>Welke blokken zitten erin? Handig voor een begrijpelijke foutmelding.</summary>
    public static List<string> Namen(string tekst)
    {
        var uit = new List<string>();
        foreach (Match m in Regex.Matches(tekst, "-----BEGIN ([A-Z0-9 ]+)-----"))
            uit.Add(m.Groups[1].Value);
        return uit;
    }
}

internal static class SleutelLezer
{
    /// <summary>PKCS#8: SEQUENCE { INTEGER versie, SEQUENCE { OID, NULL }, OCTET STRING sleutel }.</summary>
    public static RSAParameters UitPkcs8(byte[] der)
    {
        var buiten = new Asn1Lezer(der);
        var binnen = new Asn1Lezer(buiten.LeesSequence());

        binnen.Overslaan(0x02); // versie
        binnen.Overslaan(0x30); // algoritme-aanduiding

        byte[] pkcs1 = binnen.Lees(0x04); // OCTET STRING met de echte sleutel erin
        return UitPkcs1(pkcs1);
    }

    /// <summary>PKCS#1: SEQUENCE { versie, n, e, d, p, q, dp, dq, qinv }.</summary>
    public static RSAParameters UitPkcs1(byte[] der)
    {
        var buiten = new Asn1Lezer(der);
        var r = new Asn1Lezer(buiten.LeesSequence());

        r.Overslaan(0x02); // versie

        byte[] modulus = r.LeesInteger(0);
        int n = modulus.Length;            // sleutellengte in bytes
        int half = (n + 1) / 2;            // p, q, dp, dq en qinv zijn de helft

        var p = new RSAParameters();
        p.Modulus = modulus;
        p.Exponent = r.LeesInteger(0);
        p.D = r.LeesInteger(n);
        p.P = r.LeesInteger(half);
        p.Q = r.LeesInteger(half);
        p.DP = r.LeesInteger(half);
        p.DQ = r.LeesInteger(half);
        p.InverseQ = r.LeesInteger(half);
        return p;
    }
}

internal sealed class HoofdVenster : Form
{
    private readonly TextBox _cert = Veld();
    private readonly TextBox _key = Veld();
    private readonly TextBox _wachtwoord = new TextBox { UseSystemPasswordChar = true, Font = new Font("Segoe UI", 9.5f) };
    private readonly Label _status = new Label { AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft };

    private static TextBox Veld()
    {
        return new TextBox
        {
            Multiline = true,
            ScrollBars = ScrollBars.Vertical,
            Font = new Font("Consolas", 8.5f),
            Dock = DockStyle.Fill,
            WordWrap = false,
        };
    }

    public HoofdVenster()
    {
        Text = "PFX Maker -- certificaat + sleutel naar .pfx voor IIS";
        Width = 900;
        Height = 640;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(700, 500);

        var raster = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 5, Padding = new Padding(10) };
        raster.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        raster.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        raster.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
        raster.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        raster.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        raster.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        raster.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));

        raster.Controls.Add(new Label { Text = "Origin Certificate  (-----BEGIN CERTIFICATE-----)", AutoSize = true }, 0, 0);
        raster.Controls.Add(new Label { Text = "Private key  (-----BEGIN PRIVATE KEY-----)", AutoSize = true }, 1, 0);
        raster.Controls.Add(_cert, 0, 1);
        raster.Controls.Add(_key, 1, 1);

        var wwRij = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
        wwRij.Controls.Add(new Label { Text = "Wachtwoord voor de .pfx:", AutoSize = true, Padding = new Padding(0, 6, 6, 0) });
        _wachtwoord.Width = 220;
        wwRij.Controls.Add(_wachtwoord);
        wwRij.Controls.Add(new Label
        {
            Text = "(verzin er een; je hebt hem nodig bij het importeren in IIS)",
            AutoSize = true,
            ForeColor = Color.DimGray,
            Padding = new Padding(8, 6, 0, 0),
        });
        raster.Controls.Add(wwRij, 0, 2);
        raster.SetColumnSpan(wwRij, 2);

        var knop = new Button { Text = "Maak .pfx...", Height = 32, Width = 160, Anchor = AnchorStyles.Left };
        knop.Click += Maak;
        raster.Controls.Add(knop, 0, 3);
        raster.SetColumnSpan(knop, 2);

        _status.Text = "Plak beide blokken hierboven, inclusief de BEGIN- en END-regels.";
        _status.ForeColor = Color.DimGray;
        raster.Controls.Add(_status, 0, 4);
        raster.SetColumnSpan(_status, 2);

        Controls.Add(raster);
    }

    private void Melding(string tekst, Color kleur)
    {
        _status.Text = tekst;
        _status.ForeColor = kleur;
    }

    private void Maak(object zender, EventArgs e)
    {
        try
        {
            byte[] pfx;
            try
            {
                pfx = Omzetter.NaarPfx(_cert.Text, _key.Text, _wachtwoord.Text);
            }
            catch (InvalidDataException fout)
            {
                Melding(fout.Message, Color.Firebrick);
                return;
            }

            using (var dialoog = new SaveFileDialog())
            {
                dialoog.Title = "Waar moet de .pfx komen?";
                dialoog.Filter = "PKCS#12-bestand (*.pfx)|*.pfx";
                dialoog.FileName = "allmid-origin.pfx";
                if (dialoog.ShowDialog(this) != DialogResult.OK) return;

                File.WriteAllBytes(dialoog.FileName, pfx);

                // De sleutel uit beeld halen zodra hij niet meer nodig is. Iemand
                // laat dit venster open staan, en dan hoeft hij er niet meer in.
                _key.Clear();

                Melding("Klaar: " + dialoog.FileName + "  (" + pfx.Length +
                        " bytes). Het sleutelveld is geleegd.", Color.SeaGreen);
            }
        }
        catch (Exception ex)
        {
            Melding("Mislukt: " + ex.Message, Color.Firebrick);
        }
    }

}
