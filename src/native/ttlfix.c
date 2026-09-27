#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <linux/netlink.h>

#define NFNL_SUBSYS_QUEUE   3

#define NFQNL_MSG_PACKET    0
#define NFQNL_MSG_VERDICT   1
#define NFQNL_MSG_CONFIG    2

#define NFQA_PACKET_HDR     1
#define NFQA_VERDICT_HDR    2
#define NFQA_PAYLOAD        10

#define NFQA_CFG_CMD        1
#define NFQA_CFG_PARAMS     2
#define NFQA_CFG_MASK       4
#define NFQA_CFG_FLAGS      5

#define NFQNL_CFG_CMD_BIND  1

#define NFQNL_COPY_PACKET   2

#define NFQA_CFG_F_FAIL_OPEN (1U << 0)

#define NF_DROP   0
#define NF_ACCEPT 1

struct nfgenmsg {
    uint8_t  nfgen_family;
    uint8_t  version;
    uint16_t res_id;
};

struct nfqnl_msg_config_cmd {
    uint8_t  command;
    uint8_t  _pad;
    uint16_t pf;
} __attribute__((packed));

struct nfqnl_msg_config_params {
    uint32_t copy_range;
    uint8_t  copy_mode;
} __attribute__((packed));

struct nfqnl_msg_verdict_hdr {
    uint32_t verdict;
    uint32_t id;
} __attribute__((packed));

struct nfqnl_msg_packet_hdr {
    uint32_t packet_id;
    uint16_t hw_protocol;
    uint8_t  hook;
} __attribute__((packed));

struct nfattr { uint16_t nfa_len; uint16_t nfa_type; };

#define NFA_ALIGNTO      4
#define NFA_ALIGN(len)   (((len) + NFA_ALIGNTO - 1) & ~(NFA_ALIGNTO - 1))
#define NFA_HDRLEN       ((int)NFA_ALIGN(sizeof(struct nfattr)))
#define NFA_DATA(nfa)    ((void *)((char *)(nfa) + NFA_HDRLEN))
#define NFA_PAYLOAD(nfa) ((int)((nfa)->nfa_len) - NFA_HDRLEN)
#define NFA_OK(nfa,len)  ((len) >= (int)sizeof(struct nfattr) && \
                          (nfa)->nfa_len >= sizeof(struct nfattr) && \
                          (int)(nfa)->nfa_len <= (len))
#define NFA_NEXT(nfa,attrlen) \
    ((attrlen) -= NFA_ALIGN((nfa)->nfa_len), \
     (struct nfattr *)(((char *)(nfa)) + NFA_ALIGN((nfa)->nfa_len)))

static uint8_t g_ttl = 64;

static char *put_attr(struct nlmsghdr *nlh, uint16_t type,
                      const void *data, int len)
{
    struct nfattr *nfa = (struct nfattr *)((char *)nlh + NFA_ALIGN(nlh->nlmsg_len));
    nfa->nfa_len  = NFA_HDRLEN + len;
    nfa->nfa_type = type;
    if (len)
        memcpy(NFA_DATA(nfa), data, len);
    nlh->nlmsg_len = NFA_ALIGN(nlh->nlmsg_len) + NFA_ALIGN(nfa->nfa_len);
    return (char *)nlh + nlh->nlmsg_len;
}

static struct nlmsghdr *init_msg(char *buf, uint16_t msg_type,
                                 uint16_t flags, uint16_t queue_num)
{
    memset(buf, 0, NLMSG_SPACE(sizeof(struct nfgenmsg)));
    struct nlmsghdr *nlh = (struct nlmsghdr *)buf;
    nlh->nlmsg_len   = NLMSG_LENGTH(sizeof(struct nfgenmsg));
    nlh->nlmsg_type  = (NFNL_SUBSYS_QUEUE << 8) | msg_type;
    nlh->nlmsg_flags = NLM_F_REQUEST | flags;
    struct nfgenmsg *nfg = (struct nfgenmsg *)NLMSG_DATA(nlh);
    nfg->nfgen_family = AF_UNSPEC;
    nfg->version      = 0;
    nfg->res_id       = htons(queue_num);
    return nlh;
}

static int send_msg(int fd, struct nlmsghdr *nlh)
{
    struct sockaddr_nl kaddr;
    memset(&kaddr, 0, sizeof(kaddr));
    kaddr.nl_family = AF_NETLINK;
    return sendto(fd, nlh, nlh->nlmsg_len, 0,
                  (struct sockaddr *)&kaddr, sizeof(kaddr));
}

static uint16_t ip_checksum(const uint8_t *data, int len)
{
    uint32_t sum = 0;
    int i;
    for (i = 0; i + 1 < len; i += 2)
        sum += (uint32_t)((data[i] << 8) | data[i + 1]);
    if (len & 1)
        sum += (uint32_t)(data[len - 1] << 8);
    while (sum >> 16)
        sum = (sum & 0xffff) + (sum >> 16);
    return (uint16_t)(~sum & 0xffff);
}

static int rewrite(uint8_t *p, int len)
{
    if (len < 1)
        return 0;
    int ver = p[0] >> 4;
    if (ver == 4) {
        if (len < 20)
            return 0;
        int ihl = (p[0] & 0x0f) * 4;
        if (ihl < 20 || ihl > len)
            return 0;
        if (p[8] == g_ttl)
            return 0;
        p[8] = g_ttl;
        p[10] = 0; p[11] = 0;
        uint16_t ck = ip_checksum(p, ihl);
        p[10] = ck >> 8;
        p[11] = ck & 0xff;
        return 1;
    } else if (ver == 6) {
        if (len < 40)
            return 0;
        if (p[7] == g_ttl)
            return 0;
        p[7] = g_ttl;
        return 1;
    }
    return 0;
}

static void send_verdict(int fd, uint16_t queue_num, uint32_t be_id,
                         uint8_t *payload, int plen, int modified)
{
    char buf[0x10000 + 256];
    struct nlmsghdr *nlh = init_msg(buf, NFQNL_MSG_VERDICT, 0, queue_num);

    struct nfqnl_msg_verdict_hdr vh;
    vh.verdict = htonl(NF_ACCEPT);
    vh.id      = be_id;
    put_attr(nlh, NFQA_VERDICT_HDR, &vh, sizeof(vh));

    if (modified && payload && plen > 0)
        put_attr(nlh, NFQA_PAYLOAD, payload, plen);

    send_msg(fd, nlh);
}

int main(int argc, char **argv)
{
    uint16_t queue_num = 0;
    if (argc > 1) queue_num = (uint16_t)atoi(argv[1]);
    if (argc > 2) g_ttl    = (uint8_t)atoi(argv[2]);

    int fd = socket(AF_NETLINK, SOCK_RAW, NETLINK_NETFILTER);
    if (fd < 0) { perror("socket"); return 1; }

    struct sockaddr_nl addr;
    memset(&addr, 0, sizeof(addr));
    addr.nl_family = AF_NETLINK;
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind"); return 1;
    }

    int one = 1;
    setsockopt(fd, SOL_NETLINK, NETLINK_NO_ENOBUFS, &one, sizeof(one));

    char cbuf[512];
    struct nlmsghdr *nlh;

    nlh = init_msg(cbuf, NFQNL_MSG_CONFIG, NLM_F_ACK, queue_num);
    struct nfqnl_msg_config_cmd cmd = { NFQNL_CFG_CMD_BIND, 0, htons(AF_UNSPEC) };
    put_attr(nlh, NFQA_CFG_CMD, &cmd, sizeof(cmd));
    if (send_msg(fd, nlh) < 0) { perror("bind queue"); return 1; }

    nlh = init_msg(cbuf, NFQNL_MSG_CONFIG, 0, queue_num);
    struct nfqnl_msg_config_params params;
    params.copy_range = htonl(0xffff);
    params.copy_mode  = NFQNL_COPY_PACKET;
    put_attr(nlh, NFQA_CFG_PARAMS, &params, sizeof(params));
    uint32_t flags = htonl(NFQA_CFG_F_FAIL_OPEN);
    uint32_t mask  = htonl(NFQA_CFG_F_FAIL_OPEN);
    put_attr(nlh, NFQA_CFG_FLAGS, &flags, sizeof(flags));
    put_attr(nlh, NFQA_CFG_MASK,  &mask,  sizeof(mask));
    if (send_msg(fd, nlh) < 0) { perror("config params"); return 1; }

    char *rbuf = malloc(0x20000);
    if (!rbuf) { perror("malloc"); return 1; }

    for (;;) {
        ssize_t n = recv(fd, rbuf, 0x20000, 0);
        if (n < 0) {
            if (errno == ENOBUFS || errno == EINTR)
                continue;
            perror("recv");
            break;
        }
        struct nlmsghdr *h = (struct nlmsghdr *)rbuf;
        for (; NLMSG_OK(h, n); h = NLMSG_NEXT(h, n)) {
            if ((h->nlmsg_type >> 8) != NFNL_SUBSYS_QUEUE)
                continue;
            if ((h->nlmsg_type & 0xff) != NFQNL_MSG_PACKET)
                continue;

            int attrlen = h->nlmsg_len - NLMSG_LENGTH(sizeof(struct nfgenmsg));
            struct nfattr *nfa =
                (struct nfattr *)((char *)NLMSG_DATA(h) + sizeof(struct nfgenmsg));

            uint32_t be_id = 0;
            uint8_t *payload = NULL;
            int plen = 0;

            for (; NFA_OK(nfa, attrlen); nfa = NFA_NEXT(nfa, attrlen)) {
                switch (nfa->nfa_type & 0x7fff) {
                case NFQA_PACKET_HDR: {
                    struct nfqnl_msg_packet_hdr *ph = NFA_DATA(nfa);
                    be_id = ph->packet_id;
                    break;
                }
                case NFQA_PAYLOAD:
                    payload = NFA_DATA(nfa);
                    plen = NFA_PAYLOAD(nfa);
                    break;
                }
            }

            int modified = 0;
            if (payload && plen > 0)
                modified = rewrite(payload, plen);

            send_verdict(fd, queue_num, be_id, payload, plen, modified);
        }
    }

    free(rbuf);
    close(fd);
    return 0;
}
